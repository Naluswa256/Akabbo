import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppConfigModule } from '@akabbo/config';
import { PrismaModule, PrismaService } from '@akabbo/prisma';
import { AccessModule, Actor, EntitlementService, OperationContext } from '@akabbo/access';
import { IdentityModule } from '@akabbo/identity';
import { EventService, LedgerModule, MembershipService, PersonService } from '@akabbo/ledger';
import {
  CreateChargeRequest,
  CreateChargeResult,
  PAYMENT_PROVIDER,
  ProvidersModule,
} from '@akabbo/providers';
import { BillingModule, BillingService } from '@akabbo/billing';

/**
 * Billing & Entitlements DoD (metering doc §6/§7/§10): the free trial is real
 * (FREE-tier contributor cap enforced), subscriptions/packs grant on a verified
 * webhook (idempotent, source of truth), and the SMS-credit ledger reserves/
 * commits/refunds correctly. Collections use the PaymentProvider seam (faked).
 */
class FakePaymentProvider {
  readonly name = 'fake';
  lastCharge: CreateChargeRequest | null = null;
  createCharge(req: CreateChargeRequest): Promise<CreateChargeResult> {
    this.lastCharge = req;
    return Promise.resolve({ providerChargeId: `muda_${req.reference}`, status: 'pending' });
  }
  verifyAndParseWebhook(): null {
    return null;
  }
}

describe('Billing & Entitlements (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let events: EventService;
  let membership: MembershipService;
  let people: PersonService;
  let billing: BillingService;
  let entitlements: EntitlementService;
  const payments = new FakePaymentProvider();

  let seq = 0;
  const makeUser = async (): Promise<Actor> => {
    const u = await prisma.user.create({
      data: { phone: `+256715${String(seq++).padStart(6, '0')}`, phoneVerified: true },
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
      ],
    })
      .overrideProvider(PAYMENT_PROVIDER)
      .useValue(payments)
      .compile();
    prisma = moduleRef.get(PrismaService);
    events = moduleRef.get(EventService);
    membership = moduleRef.get(MembershipService);
    people = moduleRef.get(PersonService);
    billing = moduleRef.get(BillingService);
    entitlements = moduleRef.get(EntitlementService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    // Truncate everything EXCEPT the seeded plan catalog.
    await prisma.$executeRawUnsafe(
      'TRUNCATE invoice, sms_credit_ledger, entitlement_grant, billing_account, person_group, contributor_group, message, conversation, payment_instruction, event_announcement, invitation, usage_event, pending_confirmation, outbox, audit_event, allocation, fulfillment, pledge, budget_item, budget, person, event_member, event, "user", auth_otp_challenge RESTART IDENTITY CASCADE',
    );
  });

  it('a new event resolves to the FREE trial by default (metering §10)', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Free' });
    const ent = await entitlements.resolve({ eventId: event.id });
    expect(ent.planCode).toBe('FREE');
    expect(ent.maxContributors).toBe(25);
    expect(ent.smsBalance).toBe(0);
  });

  it('enforces the FREE contributor cap — the 26th contributor is blocked', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Cap' });
    const ctx = await ctxFor(owner, event.id);
    for (let i = 0; i < 25; i += 1) {
      await people.createPerson(ctx, { displayName: `P${i}` });
    }
    await expect(people.createPerson(ctx, { displayName: 'P26' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // The entitlement check names the reason.
    const decision = await entitlements.check({ eventId: event.id }, 'add_contributor');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('contributor_limit');
  });

  it('startFreeTrial grants the one-time 30 SMS credits (idempotent)', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Trial' });
    await billing.startFreeTrial(event.id, owner.userId);
    await billing.startFreeTrial(event.id, owner.userId); // idempotent
    const ent = await entitlements.resolve({ eventId: event.id });
    expect(ent.smsBalance).toBe(30);
    expect(ent.status).toBe('TRIALING');
  });

  it('buys an event pack: PENDING invoice → webhook activates the grant + credits (idempotent)', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Starter' });

    const { reference } = await billing.purchaseEventPack(
      owner.userId,
      event.id,
      'STARTER',
      '+256770000001',
    );
    expect(payments.lastCharge?.amount).toBe(50000);

    let invoice = await prisma.invoice.findUniqueOrThrow({ where: { reference } });
    expect(invoice.status).toBe('PENDING');

    // The webhook is the source of truth — it activates the plan.
    const evt = {
      gatewayTransactionId: 'gw_tx_1',
      reference,
      status: 'succeeded' as const,
      amount: 50000,
      currency: 'UGX',
    };
    const first = await billing.applyPaymentWebhook(evt);
    expect(first.applied).toBe(true);

    invoice = await prisma.invoice.findUniqueOrThrow({ where: { reference } });
    expect(invoice.status).toBe('PAID');
    const ent = await entitlements.resolve({ eventId: event.id });
    expect(ent.planCode).toBe('STARTER');
    expect(ent.maxContributors).toBe(100);
    expect(ent.smsBalance).toBe(300); // Starter's included credits

    // A duplicated webhook is a no-op — no double credit.
    const second = await billing.applyPaymentWebhook(evt);
    expect(second.applied).toBe(false);
    expect((await entitlements.resolve({ eventId: event.id })).smsBalance).toBe(300);
  });

  it('subscribes an account (metering §5): webhook activates the account grant', async () => {
    const owner = await makeUser();
    const { reference } = await billing.subscribe(owner.userId, 'ORGANIZER_PRO', '+256770000002');
    await billing.applyPaymentWebhook({
      gatewayTransactionId: 'gw_tx_2',
      reference,
      status: 'succeeded',
      amount: 100000,
      currency: 'UGX',
    });
    const account = await prisma.billingAccount.findFirstOrThrow({
      where: { ownerUserId: owner.userId },
      select: { id: true },
    });
    const ent = await entitlements.resolve({ accountId: account.id });
    expect(ent.planCode).toBe('ORGANIZER_PRO');
    expect(ent.smsBalance).toBe(1000);
  });

  it('SMS credit ledger: reserve fails closed, refund restores, commit is neutral (§6)', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Ledger' });
    const scope = { eventId: event.id };

    await billing.grantCredits(scope, 100, `grant:${event.id}`);
    expect(await billing.balance(scope)).toBe(100);

    const r1 = await billing.reserve(scope, 30, `res:1:${event.id}`);
    expect(r1.ok).toBe(true);
    expect(await billing.balance(scope)).toBe(70);

    // Reserving more than the balance fails closed — never oversell.
    const r2 = await billing.reserve(scope, 100, `res:2:${event.id}`);
    expect(r2.ok).toBe(false);
    expect(await billing.balance(scope)).toBe(70);

    // Provider rejected the message → refund the reserved credit.
    await billing.refund(scope, 30, `res:1:${event.id}`);
    expect(await billing.balance(scope)).toBe(100);

    // Commit is a 0-amount delivery marker — balance unchanged.
    await billing.commit(scope, `res:1:${event.id}`);
    expect(await billing.balance(scope)).toBe(100);
  });
});
