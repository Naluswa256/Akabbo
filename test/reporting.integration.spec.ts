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
} from '@akabbo/ledger';

/**
 * Slice B DoD — "How are we doing?" (§32, §40): target, % covered, received,
 * outstanding, contributor counts, top balances — all grounded in SQL. Plus the
 * redacted funding view a VIEWER may see (§12).
 */
describe('Slice B — event reporting (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let events: EventService;
  let membership: MembershipService;
  let people: PersonService;
  let pledges: PledgeService;
  let fulfillments: FulfillmentService;
  let queries: LedgerQueryService;

  let seq = 0;
  const makeUser = async (): Promise<Actor> => {
    const u = await prisma.user.create({
      data: { phone: `+256704${String(seq++).padStart(6, '0')}`, phoneVerified: true },
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

  it('answers "how are we doing?" with target, % covered, balances and top contributors', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, {
      name: 'Reporting',
      targetAmount: 10_000_000n,
    });
    const ctx = await ctxFor(owner, event.id);

    // John: pledged 5M, paid 4M → outstanding 1M
    const john = await people.createPerson(ctx, { displayName: 'John' });
    const jp = await pledges.createPledge(ctx, { personId: john.id, committedValue: 5_000_000n });
    await fulfillments.recordFulfillment(ctx, { pledgeId: jp.id, value: 4_000_000n });

    // Mary: pledged 3M, paid 1M → outstanding 2M
    const mary = await people.createPerson(ctx, { displayName: 'Mary' });
    const mp = await pledges.createPledge(ctx, { personId: mary.id, committedValue: 3_000_000n });
    await fulfillments.recordFulfillment(ctx, { pledgeId: mp.id, value: 1_000_000n });

    // Peter: a person with no pledge at all (not a contributor yet).
    await people.createPerson(ctx, { displayName: 'Peter' });

    const r = await queries.getEventReport(ctx);

    expect(r.target).toBe('10000000');
    expect(r.totalCommitted).toBe('8000000');
    expect(r.totalReceived).toBe('5000000');
    expect(r.totalOutstanding).toBe('3000000');
    // 5M of a 10M target
    expect(r.percentCovered).toBe(50);
    expect(r.peopleCount).toBe(3);
    expect(r.contributorCount).toBe(2); // Peter has no pledge
    expect(r.outstandingContributorCount).toBe(2);

    expect(r.topContributors[0]).toMatchObject({
      displayName: 'John',
      committed: '5000000',
      received: '4000000',
      outstanding: '1000000',
    });
    expect(r.topContributors[1].displayName).toBe('Mary');
  });

  it('percentCovered is null when no target is set (never invents a denominator)', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'No target' });
    const ctx = await ctxFor(owner, event.id);
    const r = await queries.getEventReport(ctx);
    expect(r.target).toBeNull();
    expect(r.percentCovered).toBeNull();
  });

  it('cancelled pledges leave the committed base', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Cancel', targetAmount: 1_000_000n });
    const ctx = await ctxFor(owner, event.id);
    const p = await people.createPerson(ctx, { displayName: 'Gone' });
    const pl = await pledges.createPledge(ctx, { personId: p.id, committedValue: 500_000n });
    await pledges.cancelPledge(ctx, pl.id);

    const r = await queries.getEventReport(ctx);
    expect(r.totalCommitted).toBe('0');
    expect(r.contributorCount).toBe(0);
  });

  it('a VIEWER gets the redacted funding % and is denied the full report (§12)', async () => {
    const owner = await makeUser();
    const viewer = await makeUser();
    const event = await events.createEvent(owner, {
      name: 'Privacy',
      targetAmount: 1_000_000n,
    });
    const ownerCtx = await ctxFor(owner, event.id);
    const p = await people.createPerson(ownerCtx, { displayName: 'X' });
    const pl = await pledges.createPledge(ownerCtx, { personId: p.id, committedValue: 800_000n });
    await fulfillments.recordFulfillment(ownerCtx, { pledgeId: pl.id, value: 720_000n });

    await membership.addMember(ownerCtx, viewer.userId, EventRole.VIEWER);
    const viewerCtx = await ctxFor(viewer, event.id);

    // Redacted: a percentage, no amounts.
    const funding = await queries.getFundingSummary(viewerCtx);
    expect(funding.percentCovered).toBe(72);
    expect(funding.hasTarget).toBe(true);
    expect(Object.keys(funding)).toEqual(['percentCovered', 'hasTarget']);

    // The full report is denied.
    await expect(queries.getEventReport(viewerCtx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
