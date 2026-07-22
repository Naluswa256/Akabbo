import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';

/**
 * Wires the public auth endpoints and exposes the AuthGuard for protected
 * controllers. AUTH_PROVIDER itself is provided globally by IdentityModule.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthGuard],
  exports: [AuthGuard],
})
export class AuthModule {}
