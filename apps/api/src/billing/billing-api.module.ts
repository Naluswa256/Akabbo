import { Module } from '@nestjs/common';
import { BillingModule } from '@akabbo/billing';
import { AuthModule } from '../auth/auth.module';
import { BillingController } from './billing.controller';

/** HTTP surface for Billing & Entitlements (metering doc §7/§8). */
@Module({
  imports: [BillingModule, AuthModule],
  controllers: [BillingController],
})
export class BillingApiModule {}
