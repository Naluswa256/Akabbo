import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventStatus } from '@prisma/client';
import { AppConfigModule } from '@akabbo/config';
import { PrismaModule, PrismaService } from '@akabbo/prisma';
import { AccessModule, Actor, OperationContext } from '@akabbo/access';
import { IdentityModule } from '@akabbo/identity';
import {
  EventService,
  LedgerModule,
  MembershipService,
  PersonService,
  PledgeService,
  TenantContext,
} from '@akabbo/ledger';

/**
 * Slice A DoD — event realism (§3, §12, §33):
 *  • event carries slug / status / target / date / timezone / country
 *  • lifecycle DRAFT→ACTIVE→PAUSED→CLOSED→ARCHIVED
 *  • CLOSED/ARCHIVED are READ-ONLY (the third gate), reopen for corrections
 *  • "My Events" lists a user's active memberships (§26)
 */
describe('Slice A — event lifecycle & identity (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let events: EventService;
  let membership: MembershipService;
  let people: PersonService;
  let pledges: PledgeService;
  let tenant: TenantContext;

  let seq = 0;
  const makeUser = async (): Promise<Actor> => {
    const u = await prisma.user.create({
      data: { phone: `+256703${String(seq++).padStart(6, '0')}`, phoneVerified: true },
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

  it('creates an event with slug, target, date and regional context', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, {
      name: "William & Sarah's Wedding",
      targetAmount: 25_000_000n,
      eventDate: new Date('2026-12-20T00:00:00.000Z'),
    });

    expect(event.slug).toMatch(/^william-sarah-s-wedding-[0-9a-f]{8}$/);
    expect(event.status).toBe(EventStatus.ACTIVE);
    expect(event.targetAmount).toBe('25000000');
    expect(event.eventDate).toBe('2026-12-20T00:00:00.000Z');
    expect(event.timezone).toBe('Africa/Kampala');
    expect(event.country).toBe('UG');
    expect(event.currency).toBe('UGX');
  });

  it('slugs are unique even for identically-named events', async () => {
    const owner = await makeUser();
    const a = await events.createEvent(owner, { name: 'Family Funeral' });
    const b = await events.createEvent(owner, { name: 'Family Funeral' });
    expect(a.slug).not.toBe(b.slug);
  });

  it('CLOSING an event makes the ledger read-only; reopening restores writes (§33)', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Closure' });
    let ctx = await ctxFor(owner, event.id);

    const person = await people.createPerson(ctx, { displayName: 'John' });

    // Close it — "the wedding is over".
    const closed = await events.setStatus(ctx, EventStatus.CLOSED);
    expect(closed.status).toBe(EventStatus.CLOSED);

    // Re-resolve context so it carries the new status, then every write is denied.
    ctx = await ctxFor(owner, event.id);
    await expect(people.createPerson(ctx, { displayName: 'Late' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      pledges.createPledge(ctx, { personId: person.id, committedValue: 1000n }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Reads still work — the record is preserved, not hidden.
    await expect(people.listPeople(ctx)).resolves.toHaveLength(1);

    // Reopening is permitted (authorized correction) and restores writes.
    await events.setStatus(ctx, EventStatus.ACTIVE);
    ctx = await ctxFor(owner, event.id);
    await expect(
      pledges.createPledge(ctx, { personId: person.id, committedValue: 1000n }),
    ).resolves.toBeDefined();
  });

  it('ARCHIVED is read-only too', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Archive' });
    let ctx = await ctxFor(owner, event.id);
    await events.setStatus(ctx, EventStatus.ARCHIVED);
    ctx = await ctxFor(owner, event.id);
    await expect(people.createPerson(ctx, { displayName: 'nope' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('PAUSED still allows writes (collection paused, not frozen)', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Paused' });
    let ctx = await ctxFor(owner, event.id);
    await events.setStatus(ctx, EventStatus.PAUSED);
    ctx = await ctxFor(owner, event.id);
    await expect(people.createPerson(ctx, { displayName: 'ok' })).resolves.toBeDefined();
  });

  it('updates target/date and audits old→new', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Target' });
    const ctx = await ctxFor(owner, event.id);

    const updated = await events.updateEvent(ctx, { targetAmount: 30_000_000n });
    expect(updated.targetAmount).toBe('30000000');

    // audit_event is RLS-scoped — read it inside the event's tenant scope.
    const trail = await tenant.runInEvent(event.id, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'event:update' } }),
    );
    expect(trail).toHaveLength(1);
    expect(trail[0].oldValue).toMatchObject({ targetAmount: null });
    expect(trail[0].newValue).toMatchObject({ targetAmount: '30000000' });
  });

  it('"My Events" lists only events the user is an ACTIVE member of (§26)', async () => {
    const william = await makeUser();
    const brian = await makeUser();
    await events.createEvent(william, { name: 'Wedding' });
    await events.createEvent(william, { name: 'Funeral' });
    await events.createEvent(brian, { name: "Brian's own" });

    const mine = await events.listMyEvents(william);
    expect(mine.map((e) => e.name).sort()).toEqual(['Funeral', 'Wedding']);
  });
});
