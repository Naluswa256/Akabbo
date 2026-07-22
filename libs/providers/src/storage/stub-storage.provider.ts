import { Injectable } from '@nestjs/common';
import { ProviderNotImplementedError } from '../provider.errors';
import {
  PutObjectRequest,
  PutObjectResult,
  SignedUrlRequest,
  StorageProvider,
} from './storage.provider';

/** Phase 0 stub — fails loud if invoked. Real adapter: Phase 4. */
@Injectable()
export class StubStorageProvider implements StorageProvider {
  readonly name = 'stub';

  putObject(_request: PutObjectRequest): Promise<PutObjectResult> {
    throw new ProviderNotImplementedError('StorageProvider', 'putObject', 'Phase 4');
  }

  getObject(_key: string): Promise<Buffer> {
    throw new ProviderNotImplementedError('StorageProvider', 'getObject', 'Phase 4');
  }

  getSignedUrl(_request: SignedUrlRequest): Promise<string> {
    throw new ProviderNotImplementedError('StorageProvider', 'getSignedUrl', 'Phase 4');
  }

  deleteObject(_key: string): Promise<void> {
    throw new ProviderNotImplementedError('StorageProvider', 'deleteObject', 'Phase 4');
  }
}
