import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Actor } from '@akabbo/access';
import type { AuthedRequest } from './auth.guard';

/**
 * Injects the authenticated {@link Actor} attached by {@link AuthGuard}. Throws
 * 401 if used on a route the guard did not protect (defensive — should never
 * happen in wiring).
 */
export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Actor => {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!req.actor) throw new UnauthorizedException();
    return req.actor;
  },
);
