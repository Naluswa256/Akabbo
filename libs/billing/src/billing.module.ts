import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';

/**
 * Billing & Entitlements (metering doc §7). Depends only on globals —
 * PrismaModule (data), AccessModule (EntitlementService, the read-side gate),
 * ProvidersModule (the collections-only PaymentProvider) — so it stays a thin,
 * self-contained context that other modules import for the write side.
 */
@Module({
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
