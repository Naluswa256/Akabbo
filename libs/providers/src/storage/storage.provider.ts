/**
 * Object storage provider interface (Phase 4).
 *
 * Cloudflare R2 (S3-compatible, zero egress). Documents are PRIVATE by default;
 * access is only ever via short-lived signed URLs scoped to permitted members
 * (blueprint §10). Uploaded documents are DATA, never instructions (§3.9) —
 * this interface moves bytes only; it grants no authority.
 */

export interface PutObjectRequest {
  key: string;
  body: Buffer | Uint8Array;
  contentType: string;
}

export interface PutObjectResult {
  key: string;
  etag: string;
}

export interface SignedUrlRequest {
  key: string;
  /** Seconds until the signed URL expires (kept short). */
  expiresInSeconds: number;
  operation: 'get' | 'put';
}

export interface StorageProvider {
  putObject(request: PutObjectRequest): Promise<PutObjectResult>;
  /**
   * Read the bytes back — needed server-side by the extraction worker to feed
   * a document to the multimodal model. NOT a user-facing path: users only ever
   * receive a short-lived signed URL.
   */
  getObject(key: string): Promise<Buffer>;
  getSignedUrl(request: SignedUrlRequest): Promise<string>;
  deleteObject(key: string): Promise<void>;
}
