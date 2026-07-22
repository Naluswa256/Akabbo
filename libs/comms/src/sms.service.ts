import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SmsCampaignKind, SmsCampaignStatus, SmsStatus } from '@prisma/client';
import { OperationContext, PermissionService, assertEventWritable } from '@akabbo/access';
import { OutboxWriter, TenantContext, TenantTx } from '@akabbo/ledger';
import { BillingService } from '@akabbo/billing';
import { SMS_PROVIDER, SmsProvider, SmsSendRequest } from '@akabbo/providers';

interface Recipient {
  person_id: string;
  display_name: string;
  phone: string;
}

export interface SendResult {
  campaignId: string;
  /** How many messages were queued (a reserved credit each). */
  queued: number;
  /** Recipients skipped because credits ran out (metering §6 hard stop). */
  skipped: number;
}

export interface ReminderPreview {
  recipientCount: number;
  estimatedCredits: number;
  smsBalance: number;
  /** How many we can actually afford right now. */
  affordable: number;
}

/**
 * Communications — SMS reminders & announcements (blueprint §2.4; metering §6).
 * SMS is our dominant cost and the margin engine, so every send is credit-aware:
 * RESERVE a credit when queuing (hard-stop at zero — never send SMS you can't
 * pay for), then the worker COMMITS on success or REFUNDS on failure so a failed
 * SMS never costs a credit. Recipients + delivery state are tracked for
 * "who did/didn't receive it" (§34). The provider call itself is async on the
 * worker — off the request path.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    private readonly tenant: TenantContext,
    private readonly permissions: PermissionService,
    private readonly billing: BillingService,
    private readonly outbox: OutboxWriter,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
  ) {}

  /** Preview a reminder blast: who's outstanding, and can we afford them? */
  async previewReminders(ctx: OperationContext): Promise<ReminderPreview> {
    this.permissions.assert(ctx.event.role, 'sms:read');
    const recipients = await this.tenant.runInEvent(ctx.event.eventId, (tx) =>
      this.unpaidWithPhone(tx),
    );
    const smsBalance = await this.billing.balance({ eventId: ctx.event.eventId });
    return {
      recipientCount: recipients.length,
      estimatedCredits: recipients.length,
      smsBalance,
      affordable: Math.min(recipients.length, smsBalance),
    };
  }

  /** Send a reminder to every outstanding contributor with a phone. */
  sendReminders(ctx: OperationContext, body: string): Promise<SendResult> {
    return this.dispatch(ctx, SmsCampaignKind.REMINDER, body, (tx) => this.unpaidWithPhone(tx));
  }

  /** Broadcast an announcement to every contributor with a phone. */
  sendAnnouncement(ctx: OperationContext, body: string): Promise<SendResult> {
    return this.dispatch(ctx, SmsCampaignKind.ANNOUNCEMENT, body, (tx) => this.allWithPhone(tx));
  }

  private async dispatch(
    ctx: OperationContext,
    kind: SmsCampaignKind,
    body: string,
    resolve: (tx: TenantTx) => Promise<Recipient[]>,
  ): Promise<SendResult> {
    this.permissions.assert(ctx.event.role, 'sms:send');
    assertEventWritable(ctx.event.status);
    const eventId = ctx.event.eventId;

    const recipients = await this.tenant.runInEvent(eventId, resolve);

    return this.tenant.runInEvent(eventId, async (tx) => {
      const campaign = await tx.smsCampaign.create({
        data: {
          eventId,
          kind,
          body,
          status: SmsCampaignStatus.QUEUED,
          createdById: ctx.actor.userId,
        },
        select: { id: true },
      });

      let queued = 0;
      for (const r of recipients) {
        const id = randomUUID();
        // Reserve a credit BEFORE queuing; stop the blast at the boundary when
        // we run out — never queue an SMS we can't pay for (metering §6).
        const reserved = await this.billing.reserve({ eventId }, 1, `sms:${id}`);
        if (!reserved.ok) break;
        await tx.smsMessage.create({
          data: {
            id,
            eventId,
            campaignId: campaign.id,
            personId: r.person_id,
            toPhone: r.phone,
            body: personalise(body, r.display_name),
            status: SmsStatus.QUEUED,
            reserveKey: `sms:${id}`,
          },
        });
        queued += 1;
      }

      await tx.smsCampaign.update({
        where: { id: campaign.id },
        data: {
          recipientCount: queued,
          status: queued > 0 ? SmsCampaignStatus.SENDING : SmsCampaignStatus.FAILED,
        },
      });

      // Async: the worker drains this and calls the provider (§7).
      if (queued > 0) {
        await this.outbox.enqueue(tx, {
          eventId,
          topic: 'sms.campaign',
          idempotencyKey: `sms-campaign:${campaign.id}`,
          payload: { campaignId: campaign.id },
        });
      }
      return { campaignId: campaign.id, queued, skipped: recipients.length - queued };
    });
  }

  /**
   * WORKER path (§7): send a campaign's queued messages via the provider, then
   * COMMIT each sent message's reserved credit or REFUND a failed one. Idempotent
   * — only QUEUED messages are processed, so a redelivered row is a no-op.
   */
  async processCampaign(eventId: string, campaignId: string): Promise<void> {
    const pending = await this.tenant.runInEvent(eventId, (tx) =>
      tx.smsMessage.findMany({
        where: { campaignId, status: SmsStatus.QUEUED },
        select: { id: true, toPhone: true, body: true, reserveKey: true },
      }),
    );
    if (pending.length === 0) return;

    const requests: SmsSendRequest[] = pending.map((m) => ({
      to: m.toPhone,
      body: m.body,
      idempotencyKey: m.id,
    }));
    const results = await this.sms.sendBulk(requests);

    await this.tenant.runInEvent(eventId, async (tx) => {
      let sent = 0;
      let failed = 0;
      for (let i = 0; i < pending.length; i += 1) {
        const m = pending[i];
        const res = results[i];
        if (res && res.status !== 'failed') {
          await tx.smsMessage.update({
            where: { id: m.id },
            data: {
              status: SmsStatus.SENT,
              segments: res.segments,
              providerMessageId: res.providerMessageId || null,
              sentAt: new Date(),
            },
          });
          await this.billing.commit({ eventId }, m.reserveKey);
          sent += 1;
        } else {
          await tx.smsMessage.update({
            where: { id: m.id },
            data: { status: SmsStatus.FAILED, error: 'provider rejected' },
          });
          // A failed SMS must never cost a credit (metering §6).
          await this.billing.refund({ eventId }, 1, m.reserveKey);
          failed += 1;
        }
      }
      await tx.smsCampaign.update({
        where: { id: campaignId },
        data: {
          status:
            failed === 0
              ? SmsCampaignStatus.SENT
              : sent === 0
                ? SmsCampaignStatus.FAILED
                : SmsCampaignStatus.PARTIAL,
        },
      });
      this.logger.log(`Campaign ${campaignId}: ${sent} sent, ${failed} failed`);
    });
  }

  // ── Delivery tracking (§12/§34) ───────────────────────────────────────────────

  async listCampaigns(ctx: OperationContext): Promise<unknown[]> {
    this.permissions.assert(ctx.event.role, 'sms:read');
    return this.tenant.runInEvent(ctx.event.eventId, (tx) =>
      tx.smsCampaign.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          kind: true,
          body: true,
          status: true,
          recipientCount: true,
          createdAt: true,
        },
      }),
    );
  }

  /** "Who received it / who didn't" for a campaign (or the whole event). */
  async delivery(
    ctx: OperationContext,
    campaignId?: string,
  ): Promise<{ sent: string[]; failed: string[]; pending: string[] }> {
    this.permissions.assert(ctx.event.role, 'sms:read');
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const rows = await tx.smsMessage.findMany({
        where: campaignId ? { campaignId } : {},
        select: { toPhone: true, status: true, person: { select: { displayName: true } } },
      });
      const name = (r: (typeof rows)[number]): string => r.person?.displayName ?? r.toPhone;
      return {
        sent: rows.filter((r) => r.status === SmsStatus.SENT).map(name),
        failed: rows.filter((r) => r.status === SmsStatus.FAILED).map(name),
        pending: rows.filter((r) => r.status === SmsStatus.QUEUED).map(name),
      };
    });
  }

  async getCampaign(ctx: OperationContext, campaignId: string): Promise<unknown> {
    this.permissions.assert(ctx.event.role, 'sms:read');
    const campaign = await this.tenant.runInEvent(ctx.event.eventId, (tx) =>
      tx.smsCampaign.findFirst({ where: { id: campaignId } }),
    );
    if (!campaign) throw new NotFoundException('Campaign not found in this event');
    return campaign;
  }

  // ── recipient resolution ──────────────────────────────────────────────────────

  private unpaidWithPhone(tx: TenantTx): Promise<Recipient[]> {
    return tx.$queryRaw<Recipient[]>`
      SELECT p.id AS person_id, p.display_name, p.phone
      FROM person p
      WHERE p.phone IS NOT NULL
        AND COALESCE((SELECT SUM(pl.committed_value) FROM pledge pl
                       WHERE pl.person_id = p.id AND pl.status <> 'CANCELLED'), 0)
          > COALESCE((SELECT SUM(f.value) FROM fulfillment f JOIN pledge pl2 ON f.pledge_id = pl2.id
                       WHERE pl2.person_id = p.id AND pl2.status <> 'CANCELLED'), 0)
      ORDER BY p.display_name ASC
    `;
  }

  private allWithPhone(tx: TenantTx): Promise<Recipient[]> {
    return tx.$queryRaw<Recipient[]>`
      SELECT p.id AS person_id, p.display_name, p.phone
      FROM person p WHERE p.phone IS NOT NULL ORDER BY p.display_name ASC
    `;
  }
}

/** Replace {name} with the recipient's display name (simple personalisation). */
function personalise(template: string, name: string): string {
  return template.replace(/\{name\}/gi, name);
}
