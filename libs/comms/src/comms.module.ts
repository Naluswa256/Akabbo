import { Module } from '@nestjs/common';
import { LedgerModule } from '@akabbo/ledger';
import { BillingModule } from '@akabbo/billing';
import { SmsService } from './sms.service';

/**
 * Communications (blueprint §2.4) — SMS reminders & announcements. Depends on
 * LedgerModule (TenantContext + OutboxWriter for async send), BillingModule
 * (the credit ledger), AccessModule + ProvidersModule (globals) for the gate
 * and the SMS provider seam.
 */
@Module({
  imports: [LedgerModule, BillingModule],
  providers: [SmsService],
  exports: [SmsService],
})
export class CommsModule {}
