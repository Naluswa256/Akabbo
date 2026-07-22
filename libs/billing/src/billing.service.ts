import { randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { GrantStatus, InvoiceStatus, SmsLedgerKind } from '@prisma/client';
import { EntitlementScope, EntitlementService, ResolvedEntitlement } from '@akabbo/access';
import { PrismaService } from '@akabbo/prisma';
import {
  CreateChargeResult,
  PAYMENT_PROVIDER,
  PaymentProvider,
  PaymentWebhookEvent,
} from '@akabbo/providers';

/** How many SMS credits the free trial grants, once per event (metering §10). */
const FREE_TRIAL_SMS = 30;

/**
 * Billing & Entitlements (metering doc §7 — the fifth bounded context). Owns the
 * WRITE side of billing: free trials, subscriptions, one-off event packs, the
 * append-only SMS-credit ledger, and applying payment webhooks. It collects
 * Akabbo's OWN SaaS fees (never contributor money, §8) through the collections-
 * only PaymentProvider. Grants are applied ONLY from a verified webhook, keyed
 * idempotently on the gateway transaction id (§7.4) — never from the client.
 *
 * The READ side (resolving effective limits) lives in EntitlementService so the
 * two pre-action gates stay in @akabbo/access; this service reuses it.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
  ) {}

  resolveEntitlement(scope: EntitlementScope): Promise<ResolvedEntitlement> {
    return this.entitlements.resolve(scope);
  }

  /** The payer for a user, get-or-created (idempotent). */
  async ensureBillingAccount(userId: string): Promise<{ id: string }> {
    const existing = await this.prisma.billingAccount.findFirst({
      where: { ownerUserId: userId },
      select: { id: true },
    });
    if (existing) return existing;
    return this.prisma.billingAccount.create({
      data: { ownerUserId: userId },
      select: { id: true },
    });
  }

  /**
   * Start the permanent, volume-gated FREE trial for a new event (metering §10):
   * a TRIALING FREE grant + a one-time 30-SMS allowance. Idempotent — one grant
   * per event (DB unique) and the SMS grant is keyed on the event.
   */
  async startFreeTrial(eventId: string, _ownerUserId: string): Promise<void> {
    const free = await this.plan('FREE');
    await this.prisma.entitlementGrant.upsert({
      where: { eventId },
      create: { eventId, planId: free.id, status: GrantStatus.TRIALING },
      update: {},
    });
    // 30 free credits, once — idempotency key ties it to the event.
    await this.grantCredits(
      { eventId },
      FREE_TRIAL_SMS,
      `trial-sms:${eventId}`,
      'free trial allowance',
    );
  }

  /**
   * Begin buying a one-off EVENT pack: create a PENDING invoice and initiate a
   * Mobile Money collection. The grant is applied later, from the webhook.
   */
  async purchaseEventPack(
    userId: string,
    eventId: string,
    planCode: string,
    phone: string,
    channel: 'mobile_money' | 'card' = 'mobile_money',
  ): Promise<{ invoiceId: string; reference: string; charge: CreateChargeResult }> {
    const plan = await this.plan(planCode);
    if (plan.scope !== 'EVENT') throw new BadRequestException(`${planCode} is not an event pack`);
    return this.charge(userId, plan, phone, channel, { eventId });
  }

  /** Begin an ACCOUNT subscription: PENDING invoice + collection (metering §5/§8). */
  async subscribe(
    userId: string,
    planCode: string,
    phone: string,
    channel: 'mobile_money' | 'card' = 'mobile_money',
  ): Promise<{ invoiceId: string; reference: string; charge: CreateChargeResult }> {
    const plan = await this.plan(planCode);
    if (plan.scope !== 'ACCOUNT')
      throw new BadRequestException(`${planCode} is not a subscription`);
    return this.charge(userId, plan, phone, channel, {});
  }

  private async charge(
    userId: string,
    plan: PlanRow,
    phone: string,
    channel: 'mobile_money' | 'card',
    scope: { eventId?: string },
  ): Promise<{ invoiceId: string; reference: string; charge: CreateChargeResult }> {
    const account = await this.ensureBillingAccount(userId);
    const reference = `inv_${randomBytes(12).toString('hex')}`;
    const invoice = await this.prisma.invoice.create({
      data: {
        billingAccountId: account.id,
        planId: plan.id,
        eventId: scope.eventId ?? null,
        amountMinor: plan.priceMinor,
        currency: plan.currency,
        status: InvoiceStatus.PENDING,
        reference,
      },
      select: { id: true },
    });

    const charge = await this.payments.createCharge({
      billingAccountId: account.id,
      amount: Number(plan.priceMinor),
      currency: plan.currency,
      reference,
      channel,
      phone,
      description: `Akabbo ${plan.name}`,
    });
    return { invoiceId: invoice.id, reference, charge };
  }

  /**
   * Apply a payment webhook (metering §7.4, §8) — the SOURCE OF TRUTH for grants.
   * Idempotent on the gateway transaction id: a duplicated webhook is a no-op.
   * On success: mark the invoice PAID, activate the entitlement grant for its
   * scope, and grant the plan's included SMS credits. On failure: mark FAILED.
   */
  async applyPaymentWebhook(evt: PaymentWebhookEvent): Promise<{ applied: boolean }> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { reference: evt.reference },
      select: { id: true, status: true, planId: true, eventId: true, billingAccountId: true },
    });
    if (!invoice) {
      this.logger.warn(`Webhook for unknown reference ${evt.reference}`);
      return { applied: false };
    }
    // Already settled with this gateway txn → idempotent no-op.
    if (invoice.status === InvoiceStatus.PAID) return { applied: false };

    if (evt.status === 'failed') {
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: InvoiceStatus.FAILED, gatewayTransactionId: evt.gatewayTransactionId },
      });
      return { applied: false };
    }

    const plan = invoice.planId ? await this.planById(invoice.planId) : null;
    await this.prisma.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: InvoiceStatus.PAID, gatewayTransactionId: evt.gatewayTransactionId },
      });
      if (!plan) return;

      const periodEnd = plan.isSubscription
        ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        : null;
      if (invoice.eventId) {
        // Upgrade the event's grant in place (FREE trial → paid pack).
        await tx.entitlementGrant.upsert({
          where: { eventId: invoice.eventId },
          create: {
            eventId: invoice.eventId,
            planId: plan.id,
            status: GrantStatus.ACTIVE,
            periodEnd,
          },
          update: {
            planId: plan.id,
            status: GrantStatus.ACTIVE,
            periodStart: new Date(),
            periodEnd,
          },
        });
      } else {
        await tx.entitlementGrant.create({
          data: {
            accountId: invoice.billingAccountId,
            planId: plan.id,
            status: GrantStatus.ACTIVE,
            periodEnd,
          },
        });
      }
      // Grant the plan's included SMS credits (idempotent on the invoice).
      if (plan.includedSmsCredits > 0) {
        await tx.smsCreditLedger.create({
          data: {
            eventId: invoice.eventId ?? null,
            accountId: invoice.eventId ? null : invoice.billingAccountId,
            kind: SmsLedgerKind.GRANT,
            amount: plan.includedSmsCredits,
            idempotencyKey: `invoice-sms:${invoice.id}`,
            reference: evt.reference,
          },
        });
      }
    });
    return { applied: true };
  }

  // ── SMS credit ledger (metering §6) — append-only, reserve/commit/refund ──────

  /** Add credits (purchase/top-up/free grant). Idempotent on the key. */
  async grantCredits(
    scope: EntitlementScope,
    amount: number,
    idempotencyKey: string,
    reference?: string,
  ): Promise<void> {
    await this.append(scope, SmsLedgerKind.GRANT, amount, idempotencyKey, reference);
  }

  /**
   * Reserve credits before a send (metering §6). Fails closed if the balance
   * would go negative — never send SMS you can't pay for.
   */
  async reserve(
    scope: EntitlementScope,
    count: number,
    idempotencyKey: string,
  ): Promise<{ ok: boolean; balance: number }> {
    const balance = await this.entitlements.resolve(scope).then((e) => e.smsBalance);
    if (balance < count) return { ok: false, balance };
    await this.append(scope, SmsLedgerKind.RESERVE, -count, idempotencyKey);
    return { ok: true, balance: balance - count };
  }

  /** Mark a reservation delivered (0-amount marker linked to the reservation). */
  async commit(scope: EntitlementScope, reserveKey: string): Promise<void> {
    await this.append(scope, SmsLedgerKind.COMMIT, 0, `commit:${reserveKey}`, reserveKey);
  }

  /** Refund a reserved credit when the provider rejected the message (§6). */
  async refund(scope: EntitlementScope, count: number, reserveKey: string): Promise<void> {
    await this.append(scope, SmsLedgerKind.REFUND, count, `refund:${reserveKey}`, reserveKey);
  }

  balance(scope: EntitlementScope): Promise<number> {
    return this.entitlements.resolve(scope).then((e) => e.smsBalance);
  }

  private async append(
    scope: EntitlementScope,
    kind: SmsLedgerKind,
    amount: number,
    idempotencyKey: string,
    reference?: string,
  ): Promise<void> {
    try {
      await this.prisma.smsCreditLedger.create({
        data: {
          eventId: scope.eventId ?? null,
          accountId: scope.accountId ?? null,
          kind,
          amount,
          idempotencyKey,
          reference: reference ?? null,
        },
      });
    } catch (err) {
      // Unique-violation on the key → already applied → no-op (idempotent).
      if (isUniqueViolation(err)) return;
      throw err;
    }
  }

  // ── plan catalog helpers ──────────────────────────────────────────────────────

  private async plan(code: string): Promise<PlanRow> {
    const plan = await this.prisma.plan.findUnique({ where: { code } });
    if (!plan) throw new BadRequestException(`Unknown plan: ${code}`);
    return plan as PlanRow;
  }

  private async planById(id: string): Promise<PlanRow> {
    const plan = await this.prisma.plan.findUniqueOrThrow({ where: { id } });
    return plan as PlanRow;
  }
}

interface PlanRow {
  id: string;
  code: string;
  name: string;
  scope: 'EVENT' | 'ACCOUNT';
  priceMinor: bigint;
  currency: string;
  includedSmsCredits: number;
  isSubscription: boolean;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'P2002'
  );
}
