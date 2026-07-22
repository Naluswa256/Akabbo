import { Test, TestingModule } from '@nestjs/testing';
import { AppConfigModule } from '@akabbo/config';
import { PrismaModule, PrismaService } from '@akabbo/prisma';
import { AccessModule, Actor, OperationContext } from '@akabbo/access';
import { IdentityModule } from '@akabbo/identity';
import {
  EventService,
  FulfillmentService,
  LedgerModule,
  MembershipService,
  OutboxDrainService,
  OutboxMessage,
  PersonService,
  PledgeService,
  TenantContext,
} from '@akabbo/ledger';
import {
  PAYMENT_PROVIDER,
  ProvidersModule,
  SMS_PROVIDER,
  SmsSendRequest,
  SmsSendResult,
} from '@akabbo/providers';
import { BillingModule, BillingService } from '@akabbo/billing';
import { CommsModule, SmsService } from '@akabbo/comms';

/**
 * Communications DoD (blueprint §2.4; metering §6): reminders reserve a credit
 * per recipient (hard-stop at zero), the worker sends via the provider and
 * COMMITS the credit on success or REFUNDS it on failure (a failed SMS never
 * costs a credit), and delivery is tracked for "who received / who didn't".
 */
class FakeSms {
  readonly name = 'fake';
  mode: 'all_ok' | 'all_fail' = 'all_ok';
  send(): Promise<SmsSendResult> {
    return Promise.resolve({ providerMessageId: 'x', status: 'sent', segments: 1 });
  }
  sendBulk(reqs: SmsSendRequest[]): Promise<SmsSendResult[]> {
    return Promise.resolve(
      reqs.map(() => ({
        providerMessageId: this.mode === 'all_ok' ? 'pm' : '',
        status: this.mode === 'all_ok' ? ('sent' as const) : ('failed' as const),
        segments: 1,
      })),
    );
  }
}
const fakePayments = {
  createCharge: () => Promise.resolve({ providerChargeId: 'x', status: 'pending' as const }),
  verifyAndParseWebhook: () => null,
};

describe('Communications — SMS reminders (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let events: EventService;
  let membership: MembershipService;
  let people: PersonService;
  let pledges: PledgeService;
  let fulfillments: FulfillmentService;
  let billing: BillingService;
  let sms: SmsService;
  let drain: OutboxDrainService;
  let tenant: TenantContext;
  const fakeSms = new FakeSms();

  let seq = 0;
  const makeUser = async (): Promise<Actor> => {
    const u = await prisma.user.create({
      data: { phone: `+256716${String(seq++).padStart(6, '0')}`, phoneVerified: true },
      select: { id: true },
    });
    return { userId: u.id, phoneVerified: true };
  };
  const ctxFor = async (a: Actor, e: string): Promise<OperationContext> => ({
    actor: a,
    event: await membership.requireContext(a, e),
  });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        PrismaModule,
        ProvidersModule,
        AccessModule,
        IdentityModule,
        LedgerModule,
        BillingModule,
        CommsModule,
      ],
    })
      .overrideProvider(SMS_PROVIDER)
      .useValue(fakeSms)
      .overrideProvider(PAYMENT_PROVIDER)
      .useValue(fakePayments)
      .compile();
    prisma = moduleRef.get(PrismaService);
    events = moduleRef.get(EventService);
    membership = moduleRef.get(MembershipService);
    people = moduleRef.get(PersonService);
    pledges = moduleRef.get(PledgeService);
    fulfillments = moduleRef.get(FulfillmentService);
    billing = moduleRef.get(BillingService);
    sms = moduleRef.get(SmsService);
    drain = moduleRef.get(OutboxDrainService);
    tenant = moduleRef.get(TenantContext);
    // Register the worker's sms handler (production: OutboxHandlersRegistrar).
    drain.register({
      'sms.campaign': async (msg: OutboxMessage) => {
        const p = msg.payload as { campaignId?: string };
        if (p.campaignId) await sms.processCampaign(msg.eventId, p.campaignId);
      },
    });
    await prisma.$connect();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    fakeSms.mode = 'all_ok';
    await prisma.$executeRawUnsafe(
      'TRUNCATE sms_message, sms_campaign, invoice, sms_credit_ledger, entitlement_grant, billing_account, person_group, contributor_group, message, conversation, payment_instruction, event_announcement, invitation, usage_event, pending_confirmation, outbox, audit_event, allocation, fulfillment, pledge, budget_item, budget, person, event_member, event, "user", auth_otp_challenge RESTART IDENTITY CASCADE',
    );
  });

  /** Seed N contributors, each with a phone + outstanding balance. */
  async function seedUnpaid(count: number): Promise<{ ctx: OperationContext; eventId: string }> {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'SMS' });
    const ctx = await ctxFor(owner, event.id);
    for (let i = 0; i < count; i += 1) {
      const p = await people.createPerson(ctx, {
        displayName: `C${i}`,
        phone: `+25677000${String(i).padStart(4, '0')}`,
      });
      const pl = await pledges.createPledge(ctx, { personId: p.id, committedValue: 100_000n });
      await fulfillments.recordFulfillment(ctx, { pledgeId: pl.id, value: 10_000n }); // outstanding
    }
    return { ctx, eventId: event.id };
  }

  it('reserves a credit per recipient, sends via the worker, and commits on success', async () => {
    const { ctx, eventId } = await seedUnpaid(3);
    await billing.grantCredits({ eventId }, 5, `seed:${eventId}`);

    const res = await sms.sendReminders(ctx, 'Hi {name}, please clear your pledge.');
    expect(res.queued).toBe(3);
    expect(res.skipped).toBe(0);
    // 3 credits reserved → balance 2.
    expect(await billing.balance({ eventId })).toBe(2);

    const handled = await drain.drainOnce();
    expect(handled).toBe(1);

    // All delivered → committed; balance stays 2 (reserve was the debit).
    expect(await billing.balance({ eventId })).toBe(2);
    const delivery = await sms.delivery(ctx);
    expect(delivery.sent.sort()).toEqual(['C0', 'C1', 'C2']);
    expect(delivery.failed).toHaveLength(0);
    // Personalisation happened.
    const msg = await tenant.runInEvent(eventId, (tx) =>
      tx.smsMessage.findFirstOrThrow({ where: { toPhone: '+256770000000' }, select: { body: true } }),
    );
    expect(msg.body).toContain('C0');
  });

  it('hard-stops at zero credits — the blast stops at the affordable boundary (§6)', async () => {
    const { ctx, eventId } = await seedUnpaid(3);
    await billing.grantCredits({ eventId }, 2, `seed:${eventId}`); // only 2 credits

    const res = await sms.sendReminders(ctx, 'Please pay.');
    expect(res.queued).toBe(2);
    expect(res.skipped).toBe(1);
    expect(await billing.balance({ eventId })).toBe(0);
  });

  it('a failed SMS is refunded — it never costs a credit (§6)', async () => {
    const { ctx, eventId } = await seedUnpaid(2);
    await billing.grantCredits({ eventId }, 5, `seed:${eventId}`);
    fakeSms.mode = 'all_fail';

    await sms.sendReminders(ctx, 'Please pay.');
    expect(await billing.balance({ eventId })).toBe(3); // 2 reserved

    await drain.drainOnce();
    // Both failed → both refunded → balance back to the full 5.
    expect(await billing.balance({ eventId })).toBe(5);
    const delivery = await sms.delivery(ctx);
    expect(delivery.failed.sort()).toEqual(['C0', 'C1']);
    expect(delivery.sent).toHaveLength(0);
  });

  it('preview reports recipients and affordability without sending', async () => {
    const { ctx, eventId } = await seedUnpaid(4);
    await billing.grantCredits({ eventId }, 2, `seed:${eventId}`);
    const preview = await sms.previewReminders(ctx);
    expect(preview.recipientCount).toBe(4);
    expect(preview.smsBalance).toBe(2);
    expect(preview.affordable).toBe(2);
    // Nothing queued by a preview.
    expect(await sms.listCampaigns(ctx)).toHaveLength(0);
  });
});
