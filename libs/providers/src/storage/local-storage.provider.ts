import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import {
  PutObjectRequest,
  PutObjectResult,
  SignedUrlRequest,
  StorageProvider,
} from './storage.provider';

/**
 * Local-disk storage implementing the same {@link StorageProvider} seam that
 * Cloudflare R2 will use in production (blueprint §5). It exists so the whole
 * document pipeline runs end-to-end in dev/test without cloud credentials —
 * swapping to R2 is a config change, not a redesign.
 *
 * It preserves the two properties that matter (§10):
 *   • objects are NEVER public — retrieval requires a signed, expiring token;
 *   • keys are opaque and unguessable.
 */
@Injectable()
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';

  constructor(
    private readonly rootDir: string,
    private readonly signingSecret: string,
  ) {}

  /** Object keys are opaque; callers never construct them by hand. */
  static newKey(eventId: string, filename?: string): string {
    const ext = filename?.includes('.') ? `.${filename.split('.').pop()}` : '';
    return `events/${eventId}/${randomUUID()}${ext}`;
  }

  async putObject(request: PutObjectRequest): Promise<PutObjectResult> {
    const path = this.pathFor(request.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, request.body);
    return { key: request.key, etag: randomUUID() };
  }

  async getObject(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  /**
   * A short-lived, signed reference. Mirrors R2's presigned-URL contract: the
   * token encodes the key + expiry and is verifiable without a session, but is
   * only ever HANDED OUT after a permission check in the domain layer.
   */
  getSignedUrl(request: SignedUrlRequest): Promise<string> {
    const expiresAt = Date.now() + request.expiresInSeconds * 1000;
    const signature = this.sign(request.key, expiresAt);
    const params = new URLSearchParams({
      key: request.key,
      expires: String(expiresAt),
      signature,
    });
    return Promise.resolve(`local://storage?${params.toString()}`);
  }

  /** Verify a signed reference — expiry and signature must both hold. */
  verifySignedUrl(url: string): { key: string } | null {
    const query = url.split('?')[1];
    if (!query) return null;
    const params = new URLSearchParams(query);
    const key = params.get('key');
    const expires = Number(params.get('expires'));
    const signature = params.get('signature');
    if (!key || !signature || !Number.isFinite(expires)) return null;
    if (Date.now() > expires) return null;
    if (this.sign(key, expires) !== signature) return null;
    return { key };
  }

  async deleteObject(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  private sign(key: string, expiresAt: number): string {
    return createHmac('sha256', this.signingSecret).update(`${key}:${expiresAt}`).digest('hex');
  }

  /** Resolve inside the root dir — never allow a key to escape it. */
  private pathFor(key: string): string {
    const root = resolve(this.rootDir);
    const path = resolve(join(root, key));
    if (!path.startsWith(`${root}/`) && path !== root) {
      throw new Error('Invalid storage key');
    }
    return path;
  }
}
