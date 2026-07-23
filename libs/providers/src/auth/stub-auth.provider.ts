import { Injectable } from '@nestjs/common';
import { ProviderNotImplementedError } from '../provider.errors';
import {
  AuthenticatedActor,
  AuthProvider,
  AuthSession,
  RefreshTokenRequest,
  StartOtpRequest,
  StartOtpResult,
  VerifyOtpRequest,
} from './auth.provider';

/** Phase 0 stub — fails loud if invoked. Real adapter: Phase 1. */
@Injectable()
export class StubAuthProvider implements AuthProvider {
  readonly name = 'stub';

  startOtp(_request: StartOtpRequest): Promise<StartOtpResult> {
    throw new ProviderNotImplementedError('AuthProvider', 'startOtp', 'Phase 1');
  }

  verifyOtp(_request: VerifyOtpRequest): Promise<AuthSession> {
    throw new ProviderNotImplementedError('AuthProvider', 'verifyOtp', 'Phase 1');
  }

  refreshToken(_request: RefreshTokenRequest): Promise<AuthSession> {
    throw new ProviderNotImplementedError('AuthProvider', 'refreshToken', 'Phase 1');
  }

  verifyAccessToken(_token: string): Promise<AuthenticatedActor | null> {
    throw new ProviderNotImplementedError('AuthProvider', 'verifyAccessToken', 'Phase 1');
  }
}
