import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventRole } from '@prisma/client';
import { AppConfigModule } from '@akabbo/config';
import { PrismaModule, PrismaService } from '@akabbo/prisma';
import { AccessModule, Actor, OperationContext } from '@akabbo/access';
import { IdentityModule } from '@akabbo/identity';
import {
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
 * Phase 1 DoD — proves the product's spine end-to-end against a real Postgres:
 * outstanding math, the audit trail, corrections that preserve history, RLS
 * cross-event isolation, and permission denial for a VIEWER write.
 *
 * Requires DATABASE_URL pointing at a migrated DB (CI provides one; locally the
 * throwaway container does).
 */
describe('Phase 1 — Identity + Ledger core (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let tenant: TenantContext;
  let events: EventService;
  let membership: MembershipService;
  let people: PersonService;
  let pledges: PledgeService;
  let fulfillments: FulfillmentService;
  let queries: LedgerQueryService;

  let phoneSeq = 0;
  const uniquePhone = (): string => `+256700${String(phoneSeq++).padStart(6, '0')}`;

  async function makeActor(): Promise<Actor> {
    const user = await prisma.user.create({
      data: { phone: uniquePhone(), phoneVerified: true },
      select: { id: true },
    });
    return { userId: user.id, phoneVerified: true };
  }

  const ctxFor = async (actor: Actor, eventId: string): Promise<OperationContext> => ({
    actor,
    event: await membership.requireContext(actor, eventId),
  });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, AccessModule, IdentityModule, LedgerModule],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    tenant = moduleRef.get(TenantContext);
    events = moduleRef.get(EventService);
    membership = moduleRef.get(MembershipService);
    people = moduleRef.get(PersonService);
    pledges = moduleRef.get(PledgeService);
    fulfillments = moduleRef.get(FulfillmentService);
    queries = moduleRef.get(LedgerQueryService);

    await prisma.$connect();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    // TRUNCATE is not subject to RLS (owner op), so it clears all tenants.
    await prisma.$executeRawUnsafe(
      'TRUNCATE outbox, audit_event, allocation, fulfillment, pledge, budget_item, budget, person, event_member, event, "user", auth_otp_challenge RESTART IDENTITY CASCADE',
    );
  });

  it('records the full lifecycle with correct outstanding math and a complete audit trail', async () => {
    const owner = await makeActor();
    const event = await events.createEvent(owner, { name: 'William & Sarah wedding' });
    const ctx = await ctxFor(owner, event.id);
    expect(ctx.event.role).toBe(EventRole.OWNER);

    // 3 people
    const john = await people.createPerson(ctx, { displayName: 'John Okello' });
    const mary = await people.createPerson(ctx, { displayName: 'Mary N' });
    await people.createPerson(ctx, { displayName: 'Peter M' });
    expect((await people.listPeople(ctx)).length).toBe(3);

    // 2 pledges
    const pledgeA = await pledges.createPledge(ctx, {
      personId: john.id,
      committedValue: 500000n,
    });
    await pledges.createPledge(ctx, { personId: mary.id, committedValue: 300000n });

    // partial payment on A: 200k of 500k
    const f1 = await fulfillments.recordFulfillment(ctx, { pledgeId: pledgeA.id, value: 200000n });
    expect(f1.outstanding).toBe('300000');
    expect(f1.pledgeStatus).toBe('PARTIALLY_FULFILLED');

    // correction: A's committed value 500k → 600k (history preserved)
    await pledges.correctCommittedValue(ctx, pledgeA.id, 600000n);
    const outA = await queries.getPledgeOutstanding(ctx, pledgeA.id);
    expect(outA.committedValue).toBe('600000');
    expect(outA.totalFulfilled).toBe('200000');
    expect(outA.outstanding).toBe('400000'); // 600k − 200k

    // event totals: committed 600k + 300k = 900k; fulfilled 200k; outstanding 700k
    const totals = await queries.getEventTotals(ctx);
    expect(totals.totalCommitted).toBe('900000');
    expect(totals.totalFulfilled).toBe('200000');
    expect(totals.totalOutstanding).toBe('700000');

    // audit trail for pledge A: create then correction (old→new, manual_correction)
    const trail = await queries.getAuditTrail(ctx, 'pledge', pledgeA.id);
    expect(trail.map((t) => t.action)).toEqual(['pledge:create', 'pledge:correct']);
    const correction = trail[1];
    expect(correction.source).toBe('manual_correction');
    expect(correction.oldValue).toMatchObject({ committedValue: '500000' });
    expect(correction.newValue).toMatchObject({ committedValue: '600000' });
    expect(correction.actorUserId).toBe(owner.userId);
  });

  it('provenance on every commitment/fulfillment is human_typed (Phase 1)', async () => {
    const owner = await makeActor();
    const event = await events.createEvent(owner, { name: 'Provenance check' });
    const ctx = await ctxFor(owner, event.id);
    const p = await people.createPerson(ctx, { displayName: 'Jane' });
    const pledge = await pledges.createPledge(ctx, { personId: p.id, committedValue: 100000n });
    expect(pledge.source).toBe('human_typed');
  });

  it('recording a fulfillment enqueues exactly one outbox row (Phase 3 seam)', async () => {
    const owner = await makeActor();
    const event = await events.createEvent(owner, { name: 'Outbox seam' });
    const ctx = await ctxFor(owner, event.id);
    const p = await people.createPerson(ctx, { displayName: 'Sam' });
    const pledge = await pledges.createPledge(ctx, { personId: p.id, committedValue: 100000n });
    const f = await fulfillments.recordFulfillment(ctx, { pledgeId: pledge.id, value: 50000n });

    const rows = await tenant.runInEvent(event.id, (tx) =>
      tx.outbox.findMany({ where: { topic: 'contribution.recorded' } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(`fulfillment:${f.id}`);
    expect(rows[0].status).toBe('PENDING');
  });

  it('RLS: a member of event A cannot read event B rows (§3.7)', async () => {
    const ownerA = await makeActor();
    const ownerB = await makeActor();
    const eventA = await events.createEvent(ownerA, { name: 'Event A' });
    const eventB = await events.createEvent(ownerB, { name: 'Event B' });

    const ctxA = await ctxFor(ownerA, eventA.id);
    const ctxB = await ctxFor(ownerB, eventB.id);
    await people.createPerson(ctxA, { displayName: 'A-only person' });
    await people.createPerson(ctxB, { displayName: 'B-only person' });

    // Scoped to A, only A's person is visible — B's row is filtered by RLS.
    const seenFromA = await tenant.runInEvent(eventA.id, (tx) =>
      tx.person.findMany({ select: { displayName: true } }),
    );
    expect(seenFromA.map((p) => p.displayName)).toEqual(['A-only person']);

    // ownerA is not a member of B → cannot obtain a context there.
    await expect(membership.requireContext(ownerA, eventB.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('a VIEWER is denied every write (permission gate, Phase 1 DoD)', async () => {
    const owner = await makeActor();
    const viewer = await makeActor();
    const event = await events.createEvent(owner, { name: 'Perms' });
    const ownerCtx = await ctxFor(owner, event.id);

    // Owner adds the second user as a VIEWER.
    await membership.addMember(ownerCtx, viewer.userId, EventRole.VIEWER);
    const viewerCtx = await ctxFor(viewer, event.id);
    expect(viewerCtx.event.role).toBe(EventRole.VIEWER);

    // Every write is forbidden…
    await expect(
      people.createPerson(viewerCtx, { displayName: 'nope' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // …and (post-1.5a finance privacy, §12) a VIEWER cannot read amounts/roster.
    await expect(people.listPeople(viewerCtx)).rejects.toBeInstanceOf(ForbiddenException);

    const person = await people.createPerson(ownerCtx, { displayName: 'by owner' });
    await expect(
      pledges.createPledge(viewerCtx, { personId: person.id, committedValue: 1000n }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a non-member cannot obtain any context (fails closed)', async () => {
    const owner = await makeActor();
    const stranger = await makeActor();
    const event = await events.createEvent(owner, { name: 'Closed' });
    await expect(membership.requireContext(stranger, event.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
