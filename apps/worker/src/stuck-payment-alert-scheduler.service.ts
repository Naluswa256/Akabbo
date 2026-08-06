import {
  Inject,
  Injectable,
  Logger,
  Optional,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AppConfigService } from '@akabbo/config';
import { BillingService, InvoiceRow } from '@akabbo/billing';
import { EMAIL_PROVIDER, EmailProvider } from '@akabbo/providers';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Emails the admin inbox once when a payment has been PENDING too long with
 * no webhook resolution — the fallback for whatever the webhook fixes
 * (silent error swallowing, the Muda status-string mismatch, both fixed
 * alongside this) don't catch, or a genuinely lost callback. There is no
 * other mechanism today that would ever surface a lost payment — the system
 * is purely webhook-driven with no reconciliation job, so this is the first
 * one. Disabled (skips entirely) when ADMIN_ALERT_EMAIL is unset.
 */
@Injectable()
export class StuckPaymentAlertSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StuckPaymentAlertSchedulerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly billing: BillingService,
    @Optional() @Inject(EMAIL_PROVIDER) private readonly email?: EmailProvider,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('ADMIN_ALERT_EMAIL')) {
      this.logger.log('Stuck-payment alerting disabled (ADMIN_ALERT_EMAIL unset)');
      return;
    }
    this.logger.log(`Stuck-payment alert scheduler starting (every ${CHECK_INTERVAL_MS}ms)`);
    this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const adminEmail = this.config.get('ADMIN_ALERT_EMAIL');
      const thresholdMinutes = this.config.get('STUCK_INVOICE_THRESHOLD_MINUTES');
      const stuck = await this.billing.findStuckPendingInvoices(thresholdMinutes);
      if (stuck.length === 0) return;

      if (this.email) {
        await this.email.send({
          to: adminEmail,
          subject: `Akabbo: ${stuck.length} payment(s) stuck PENDING`,
          body: renderStuckInvoicesEmail(stuck, thresholdMinutes),
          idempotencyKey: `stuck-invoices:${stuck.map((s) => s.id).join(',')}:${Date.now()}`,
        });
      } else {
        this.logger.warn(
          `${stuck.length} stuck invoice(s) found but no EmailProvider configured — cannot alert`,
        );
      }
      await this.billing.markStuckAlertSent(stuck.map((s) => s.id));
      this.logger.log(`Alerted on ${stuck.length} stuck invoice(s)`);
    } catch (err) {
      this.logger.warn(
        `Stuck-payment check failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    } finally {
      this.running = false;
    }
  }
}

function renderStuckInvoicesEmail(invoices: InvoiceRow[], thresholdMinutes: number): string {
  const lines = invoices.map((inv) => {
    const ageMinutes = Math.round((Date.now() - inv.createdAt.getTime()) / 60000);
    return (
      `- ${inv.reference} — ${inv.amountMinor.toString()} ${inv.currency}, ` +
      `pending ${ageMinutes}m (invoice id: ${inv.id}, event: ${inv.eventId ?? 'account-level'})`
    );
  });
  return (
    `${invoices.length} payment(s) have been PENDING for over ${thresholdMinutes} minutes ` +
    `with no webhook resolution:\n\n${lines.join('\n')}\n\n` +
    `Check each reference on the Muda dashboard. If Muda shows it successful, reconcile it with:\n` +
    `POST /admin/invoices/:id/reconcile { "gatewayTransactionId": "<muda transaction id>" }\n\n` +
    `This alert won't repeat for the same invoice while it stays PENDING.`
  );
}
