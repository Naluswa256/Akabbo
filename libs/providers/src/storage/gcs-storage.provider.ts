import { Logger } from '@nestjs/common';
import {
  PutObjectRequest,
  PutObjectResult,
  SignedUrlRequest,
  StorageProvider,
} from './storage.provider';

export interface GcsConfig {
  bucket: string;
  /** Service account email used to sign URLs (usually the Cloud Run SA). */
  serviceAccountEmail: string;
  /**
   * Base URL for the GCS JSON API. Overridable for testing; defaults to the
   * real GCS endpoint.
   */
  apiBaseUrl?: string;
}

interface GcsAccessToken {
  value: string;
  expiresAt: number;
}

/**
 * Google Cloud Storage adapter (Phase 4 production storage).
 *
 * Implements the same {@link StorageProvider} seam as {@link LocalStorageProvider}
 * so swapping is a config change (`STORAGE_PROVIDER=gcs`). Uses the GCS JSON
 * REST API authenticated with the Cloud Run metadata-server token — no SDK, no
 * extra package, no key file needed when running on GCP.
 *
 * Objects are NEVER public (blueprint §10): retrieval is always via a V4 signed
 * URL generated with IAM signBlob, handed out only AFTER a permission check in
 * the domain layer.
 */
export class GcsStorageProvider implements StorageProvider {
  readonly name = 'gcs';
  private readonly logger = new Logger(GcsStorageProvider.name);
  private readonly apiBase: string;
  private token: GcsAccessToken | null = null;

  constructor(private readonly config: GcsConfig) {
    this.apiBase = config.apiBaseUrl ?? 'https://storage.googleapis.com';
  }

  async putObject(request: PutObjectRequest): Promise<PutObjectResult> {
    const token = await this.getToken();
    const url = `${this.apiBase}/upload/storage/v1/b/${encodeURIComponent(this.config.bucket)}/o?uploadType=media&name=${encodeURIComponent(request.key)}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': request.contentType,
        'content-length': String(request.body.length),
      },
      // Cast: Node 22 fetch accepts Buffer at runtime; strict TS narrows on
      // ArrayBufferLike vs ArrayBuffer so a type cast is the safe escape hatch.
      body: request.body as unknown as BodyInit,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.error(`GCS putObject failed (${res.status}): ${body}`);
      throw new Error(`GCS putObject failed: HTTP ${res.status}`);
    }

    const json = (await res.json()) as { etag?: string };
    return { key: request.key, etag: json.etag ?? '' };
  }

  async getObject(key: string): Promise<Buffer> {
    const token = await this.getToken();
    const url = `${this.apiBase}/storage/v1/b/${encodeURIComponent(this.config.bucket)}/o/${encodeURIComponent(key)}?alt=media`;

    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      throw new Error(`GCS getObject failed: HTTP ${res.status} for key=${key}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * V4 signed URL via IAM signBlob — works on Cloud Run without a key file.
   * The Cloud Run service account must have `roles/iam.serviceAccountTokenCreator`
   * on itself (self-sign) or the signing SA set in GcsConfig.
   */
  async getSignedUrl(request: SignedUrlRequest): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const expiry = request.expiresInSeconds;
    const method = request.operation === 'put' ? 'PUT' : 'GET';
    const bucket = this.config.bucket;
    const key = request.key;
    const saEmail = this.config.serviceAccountEmail;

    const datestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const credentialScope = `${datestamp}/auto/storage/goog4_request`;
    const credential = `${saEmail}/${credentialScope}`;

    const canonicalHeaders = 'host:storage.googleapis.com\n';
    const signedHeaders = 'host';

    const canonicalQueryString = [
      `X-Goog-Algorithm=GOOG4-RSA-SHA256`,
      `X-Goog-Credential=${encodeURIComponent(credential)}`,
      `X-Goog-Date=${datestamp}T000000Z`,
      `X-Goog-Expires=${expiry}`,
      `X-Goog-SignedHeaders=${signedHeaders}`,
    ]
      .sort()
      .join('&');

    const canonicalRequest = [
      method,
      `/${bucket}/${key}`,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const { createHash } = await import('node:crypto');
    const canonicalHash = createHash('sha256').update(canonicalRequest).digest('hex');

    const stringToSign = [
      'GOOG4-RSA-SHA256',
      `${datestamp}T000000Z`,
      credentialScope,
      canonicalHash,
    ].join('\n');

    // Use IAM signBlob to sign without a key file (works on Cloud Run).
    const signature = await this.signWithIam(saEmail, stringToSign);

    const signedUrl =
      `https://storage.googleapis.com/${bucket}/${encodeURIComponent(key)}` +
      `?${canonicalQueryString}&X-Goog-Signature=${signature}`;

    // Suppress the unused variable warning — `now` is kept for clarity above.
    void now;

    return signedUrl;
  }

  async deleteObject(key: string): Promise<void> {
    const token = await this.getToken();
    const url = `${this.apiBase}/storage/v1/b/${encodeURIComponent(this.config.bucket)}/o/${encodeURIComponent(key)}`;

    const res = await fetch(url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });

    // 404 means already deleted — treat as success (idempotent).
    if (!res.ok && res.status !== 404) {
      throw new Error(`GCS deleteObject failed: HTTP ${res.status} for key=${key}`);
    }
  }

  // ── Auth ──────────────────────────────────────────────────────────────────────

  /**
   * Fetch an access token from the Cloud Run metadata server. Cached until 60s
   * before expiry (same pattern as MudaTechProvider).
   */
  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;

    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'metadata-flavor': 'Google' } },
    );

    if (!res.ok) throw new Error(`GCS metadata token failed: HTTP ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      value: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000 - 60_000,
    };
    return this.token.value;
  }

  /** Sign a string with IAM signBlob (keyless, works on Cloud Run). */
  private async signWithIam(saEmail: string, stringToSign: string): Promise<string> {
    const token = await this.getToken();
    const { Buffer: Buf } = await import('node:buffer');
    const encodedPayload = Buf.from(stringToSign).toString('base64');

    const res = await fetch(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(saEmail)}:signBlob`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ payload: encodedPayload }),
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`IAM signBlob failed (${res.status}): ${body}`);
    }

    const json = (await res.json()) as { signedBlob?: string };
    if (!json.signedBlob) throw new Error('IAM signBlob returned empty signature');
    return json.signedBlob;
  }
}
