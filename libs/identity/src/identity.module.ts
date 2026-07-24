import { Global, Module } from '@nestjs/common';
import { AUTH_PROVIDER } from '@akabbo/providers';
import { UserService } from './user.service';
import { LocalAuthProvider } from './local-auth.provider';

/**
 * Identity context — users and authentication. Binds the real AUTH_PROVIDER
 * (OTP+JWT) so the rest of the app injects the token, never the concrete class.
 * Global so the API's auth guard can resolve AUTH_PROVIDER anywhere.
 *
 * Deliberately has NO dependency on billing: `AuthSession.isNewUser` tells the
 * API-layer AuthController to start the account's free trial — starting it
 * here would force every consumer of this @Global() module (i.e. nearly every
 * test in the repo) to also satisfy the full payment-provider graph.
 */
@Global()
@Module({
  providers: [
    UserService,
    LocalAuthProvider,
    { provide: AUTH_PROVIDER, useExisting: LocalAuthProvider },
  ],
  exports: [UserService, AUTH_PROVIDER, LocalAuthProvider],
})
export class IdentityModule {}
