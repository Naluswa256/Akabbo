import { Module } from '@nestjs/common';
import { BillingModule } from '@akabbo/billing';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';

/**
 * Wires the public auth endpoints and exposes the AuthGuard for protected
 * controllers. AUTH_PROVIDER itself is provided globally by IdentityModule.
 * BillingModule is imported here (not in IdentityModule) so AuthController can
 * start a new account's free trial without forcing every @Global() IdentityModule
 * consumer to also satisfy the payment-provider graph.
 */
@Module({
  imports: [BillingModule],
  controllers: [AuthController],
  providers: [AuthGuard],
  exports: [AuthGuard],
})
export class AuthModule {}
