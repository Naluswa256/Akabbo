import { Test, TestingModule } from '@nestjs/testing';
import { PaymentMethod, PledgeStatus, VerificationStatus } from '@prisma/client';
import { AppConfigModule } from '@akabbo/config';
import { PrismaModule, PrismaService } from '@akabbo/prisma';
import { AccessModule, Actor, OperationContext } from '@akabbo/access';
import { IdentityModule } from '@akabbo/identity';
import {
  DuplicateSuspectedException,
  EventService,
  FulfillmentService,
  LedgerModule,
  LedgerQueryService,
  MembershipService,
  PersonService,
  PledgeService,
  TenantContext,
} from '@akabbo/ledger';

/**
 * Slice C DoD — financial integrity (§14, §15, §25, §42):
 *  • payment method recorded; verification is REPORTED, never auto-VERIFIED
 *  • spontaneous cash with no prior pledge just works (direct contribution)
 *  • a retried write with the same key never books the money twice
 *  • an identical payment moments later stops and asks
 */
describe('Slice C — financial integrity (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let events: EventService;
  let membership: MembershipService;
  let people: PersonService;
  let pledges: PledgeService;
  let fulfillments: FulfillmentService;
  let queries: LedgerQueryService;
  let tenant: TenantContext;

  let seq = 0;
  const makeUser = async (): Promise<Actor> => {
    const u = await prisma.user.create({
      data: { phone: `+256705${String(seq++).padStart(6, '0')}`, phoneVerified: true },
      select: { id: true },
    });
    return { userId: u.id, phoneVerified: true };
  };
  const ctxFor = async (actor: Actor, eventId: string): Promise<OperationContext> => ({
    actor,
    event: await membership.requireContext(actor, eventId),
  });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, AccessModule, IdentityModule, LedgerModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    events = moduleRef.get(EventService);
    membership = moduleRef.get(MembershipService);
    people = moduleRef.get(PersonService);
    pledges = moduleRef.get(PledgeService);
    fulfillments = moduleRef.get(FulfillmentService);
    queries = moduleRef.get(LedgerQueryService);
    tenant = moduleRef.get(TenantContext);
    await prisma.$connect();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE invitation, usage_event, pending_confirmation, outbox, audit_event, allocation, fulfillment, pledge, budget_item, budget, person, event_member, event, "user", auth_otp_challenge RESTART IDENTITY CASCADE',
    );
  });

  const setup = async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Money' });
    const ctx = await ctxFor(owner, event.id);
    return { owner, event, ctx };
  };

  it('records the payment method and is HONEST about verification (§14)', async () => {
    const { ctx } = await setup();
    const p = await people.createPerson(ctx, { displayName: 'John' });
    const pl = await pledges.createPledge(ctx, { personId: p.id, committedValue: 500_000n });

    const f = await fulfillments.recordFulfillment(ctx, {
      pledgeId: pl.id,
      value: 200_000n,
      method: PaymentMethod.MTN,
      note: 'MoMo to William',
    });

    expect(f.method).toBe(PaymentMethod.MTN);
    // Never claims verification without evidence.
    expect(f.verificationStatus).toBe(VerificationStatus.REPORTED);
    expect(f.outstanding).toBe('300000');
  });

  it('records spontaneous cash with NO prior pledge (§15) — direct contribution', async () => {
    const { ctx } = await setup();
    const peter = await people.createPerson(ctx, { displayName: 'Peter' });

    // "Peter gave me 100k cash" — no pledge exists.
    const f = await fulfillments.recordDirectContribution(ctx, {
      personId: peter.id,
      value: 100_000n,
      method: PaymentMethod.CASH,
    });

    expect(f.method).toBe(PaymentMethod.CASH);
    expect(f.pledgeStatus).toBe(PledgeStatus.FULFILLED);
    expect(f.outstanding).toBe('0');

    // It shows up in the ledger as a fully-discharged commitment.
    const report = await queries.getEventReport(ctx);
    expect(report.totalCommitted).toBe('100000');
    expect(report.totalReceived).toBe('100000');
    expect(report.totalOutstanding).toBe('0');

    // and is flagged as direct (pledge is RLS-scoped — read in tenant scope).
    const pledge = await tenant.runInEvent(ctx.event.eventId, (tx) =>
      tx.pledge.findFirst({ where: { id: f.pledgeId }, select: { isDirect: true } }),
    );
    expect(pledge?.isDirect).toBe(true);
  });

  it('IDEMPOTENT: the same key never books the money twice (§42)', async () => {
    const { ctx } = await setup();
    const p = await people.createPerson(ctx, { displayName: 'John' });
    const pl = await pledges.createPledge(ctx, { personId: p.id, committedValue: 500_000n });

    const key = 'client-key-abc12345';
    const first = await fulfillments.recordFulfillment(ctx, {
      pledgeId: pl.id,
      value: 200_000n,
      idempotencyKey: key,
    });
    // The user's connection dropped and the client retried the same action.
    const retry = await fulfillments.recordFulfillment(ctx, {
      pledgeId: pl.id,
      value: 200_000n,
      idempotencyKey: key,
    });

    expect(retry.id).toBe(first.id);
    expect(retry.idempotentReplay).toBe(true);

    // Only ONE payment was booked.
    const totals = await queries.getEventTotals(ctx);
    expect(totals.totalFulfilled).toBe('200000');
  });

  it('idempotency also protects direct contributions', async () => {
    const { ctx } = await setup();
    const peter = await people.createPerson(ctx, { displayName: 'Peter' });
    const key = 'direct-key-abc12345';

    const a = await fulfillments.recordDirectContribution(ctx, {
      personId: peter.id,
      value: 100_000n,
      idempotencyKey: key,
    });
    const b = await fulfillments.recordDirectContribution(ctx, {
      personId: peter.id,
      value: 100_000n,
      idempotencyKey: key,
    });

    expect(b.id).toBe(a.id);
    const totals = await queries.getEventTotals(ctx);
    // One commitment, one payment — not two.
    expect(totals.totalCommitted).toBe('100000');
    expect(totals.totalFulfilled).toBe('100000');
  });

  it('DUPLICATE-AWARE: an identical payment moments later stops and asks (§25)', async () => {
    const { ctx } = await setup();
    const p = await people.createPerson(ctx, { displayName: 'John' });
    const pl = await pledges.createPledge(ctx, { personId: p.id, committedValue: 1_000_000n });

    await fulfillments.recordFulfillment(ctx, { pledgeId: pl.id, value: 500_000n });

    // "John sent 500k" again — same amount, moments later.
    await expect(
      fulfillments.recordFulfillment(ctx, { pledgeId: pl.id, value: 500_000n }),
    ).rejects.toBeInstanceOf(DuplicateSuspectedException);

    // Still only one payment recorded.
    let totals = await queries.getEventTotals(ctx);
    expect(totals.totalFulfilled).toBe('500000');

    // Confirming it IS a separate payment records it.
    await fulfillments.recordFulfillment(ctx, {
      pledgeId: pl.id,
      value: 500_000n,
      confirmDuplicate: true,
    });
    totals = await queries.getEventTotals(ctx);
    expect(totals.totalFulfilled).toBe('1000000');
  });

  it('a different amount is not treated as a duplicate', async () => {
    const { ctx } = await setup();
    const p = await people.createPerson(ctx, { displayName: 'John' });
    const pl = await pledges.createPledge(ctx, { personId: p.id, committedValue: 1_000_000n });

    await fulfillments.recordFulfillment(ctx, { pledgeId: pl.id, value: 300_000n });
    await expect(
      fulfillments.recordFulfillment(ctx, { pledgeId: pl.id, value: 200_000n }),
    ).resolves.toBeDefined();
  });
});
