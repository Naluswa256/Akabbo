import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AUTH_PROVIDER, AuthProvider } from '@akabbo/providers';
import type { Actor } from '@akabbo/access';

/** Express request augmented with the authenticated actor. */
export interface AuthedRequest extends Request {
  actor?: Actor;
}

/**
 * Authenticates a request from the `Authorization: Bearer <token>` header via
 * the AUTH_PROVIDER (never by trusting client-supplied identity). Attaches the
 * resolved {@link Actor} to the request. Fails closed: no/invalid token → 401.
 *
 * This establishes IDENTITY only. Authorization is enforced separately, inside
 * the domain services, by the permission engine (§10).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AUTH_PROVIDER) private readonly auth: AuthProvider) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const actor = await this.auth.verifyAccessToken(header.slice('Bearer '.length));
    if (!actor) throw new UnauthorizedException('Invalid or expired token');
    req.actor = actor;
    return true;
  }
}
