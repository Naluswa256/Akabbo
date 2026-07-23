import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventStatus } from '@prisma/client';
import { AppConfigModule } from '@akabbo/config';
import { PrismaModule, PrismaService } from '@akabbo/prisma';
import { AccessModule, Actor, OperationContext } from '@akabbo/access';
import { IdentityModule } from '@akabbo/identity';
import { EventService, LedgerModule, MembershipService } from '@akabbo/ledger';
import { currentDateNote } from '@akabbo/ai';

/**
 * Free-trial enforcement that can't be cheated (metering §10): the free tier
 * covers ONE active event, keyed on the OWNER — so a new login, a new access
 * token, or resetting the conversation cannot hand out a fresh free allowance.
 * A subscription raises the ceiling. Plus: the AI always knows today's date.
 */
describe('Plan enforcement — active-event cap (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let events: EventService;
  let membership: MembershipService;

  let seq = 0;
  const makeUser = async (): Promise<Actor> => {
    const u = await prisma.user.create({
      data: { phone: `+256719${String(seq++).padStart(6, '0')}`, phoneVerified: true },
      select: { id: true },
    });
    return { userId: u.id, phoneVerified: true };
  };
  const ctxFor = async (a: Actor, e: string): Promise<OperationContext> => ({
    actor: a,
    event: await membership.requireContext(a, e),
  });
  const subscribe = async (userId: string, code: string): Promise<void> => {
    const account = await prisma.billingAccount.create({
      data: { ownerUserId: userId },
      select: { id: true },
    });
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code }, select: { id: true } });
    await prisma.entitlementGrant.create({
      data: { accountId: account.id, planId: plan.id, status: 'ACTIVE' },
    });
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, AccessModule, IdentityModule, LedgerModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    events = moduleRef.get(EventService);
    membership = moduleRef.get(MembershipService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE entitlement_grant, billing_account, invitation, usage_event, pending_confirmation, outbox, audit_event, allocation, fulfillment, pledge, budget_item, budget, person, event_member, event, "user", auth_otp_challenge RESTART IDENTITY CASCADE',
    );
  });

  it('free tier allows ONE active event; the second is blocked with an upgrade prompt', async () => {
    const owner = await makeUser();
    await events.createEvent(owner, { name: 'First' });
    await expect(events.createEvent(owner, { name: 'Second' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('the cap is keyed on the OWNER, not a session — re-auth / new token cannot bypass it', async () => {
    const owner = await makeUser();
    await events.createEvent(owner, { name: 'Only' });
    // Simulate a fresh login / new access token: a brand-new Actor object, SAME user.
    const reauthed: Actor = { userId: owner.userId, phoneVerified: true };
    await expect(events.createEvent(reauthed, { name: 'Sneaky' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('closing the first event frees the slot', async () => {
    const owner = await makeUser();
    const first = await events.createEvent(owner, { name: 'Closeable' });
    await events.setStatus(await ctxFor(owner, first.id), EventStatus.CLOSED);
    // A closed event no longer counts against the active-event ceiling.
    await expect(events.createEvent(owner, { name: 'Next' })).resolves.toMatchObject({
      name: 'Next',
    });
  });

  it('a subscription raises the ceiling (Business = unlimited)', async () => {
    const owner = await makeUser();
    await subscribe(owner.userId, 'BUSINESS');
    await events.createEvent(owner, { name: 'A' });
    await events.createEvent(owner, { name: 'B' });
    await expect(events.createEvent(owner, { name: 'C' })).resolves.toMatchObject({ name: 'C' });
  });

  it('the AI is given the current date so it never guesses the year', () => {
    const note = currentDateNote();
    const year = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Kampala',
      year: 'numeric',
    }).format(new Date());
    expect(note).toContain(year);
    expect(note.toLowerCase()).toContain('never ask');
  });
});
