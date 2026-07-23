import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventRole, InvitationStatus } from '@prisma/client';
import { AppConfigModule } from '@akabbo/config';
import { PrismaModule, PrismaService } from '@akabbo/prisma';
import { AccessModule, Actor, OperationContext } from '@akabbo/access';
import { IdentityModule } from '@akabbo/identity';
import {
  EventService,
  InvitationService,
  LedgerModule,
  MembershipService,
  PersonService,
  TenantContext,
} from '@akabbo/ledger';

/**
 * Phase 1.5a DoD — the identity foundation:
 *  • invite a NON-user → they authenticate → accept → become a member (§4–§5)
 *  • accept is idempotent (accept twice / already-member) (§42)
 *  • a revoked/expired token is inert (§36)
 *  • Person↔User linkage is duplicate-safe (design review §0)
 *  • CO_OWNER is a peer; non-owner cannot invite
 */
describe('Phase 1.5a — identity foundation (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let events: EventService;
  let membership: MembershipService;
  let invitations: InvitationService;
  let people: PersonService;
  let tenant: TenantContext;

  let seq = 0;
  const makeUser = async (): Promise<Actor> => {
    const u = await prisma.user.create({
      data: { phone: `+256702${String(seq++).padStart(6, '0')}`, phoneVerified: true },
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
    invitations = moduleRef.get(InvitationService);
    people = moduleRef.get(PersonService);
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

  /** Give an event a seat-bearing plan so invitations aren't blocked by the
   *  FREE seat cap (metering §7). PREMIUM = unlimited seats. */
  const grantSeats = async (eventId: string): Promise<void> => {
    const plan = await prisma.plan.findUniqueOrThrow({
      where: { code: 'PREMIUM' },
      select: { id: true },
    });
    await prisma.entitlementGrant.create({
      data: { eventId, planId: plan.id, status: 'ACTIVE' },
    });
  };

  it('invites a non-user who later authenticates and accepts → becomes a COORDINATOR', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Invite flow' });
    await grantSeats(event.id);
    const ownerCtx = await ctxFor(owner, event.id);

    // Owner creates an invitation (no target account exists yet).
    const invite = await invitations.createInvitation(ownerCtx, { role: EventRole.COORDINATOR });
    expect(invite.token).toBeDefined();

    // Public landing view (pre-auth) shows event + role, no membership.
    const publicView = await invitations.getByToken(invite.token);
    expect(publicView.eventName).toBe('Invite flow');
    expect(publicView.role).toBe(EventRole.COORDINATOR);
    expect(publicView.valid).toBe(true);

    // Brian authenticates (simulated: his user now exists) and accepts.
    const brian = await makeUser();
    // Before accepting he is NOT a member.
    await expect(membership.requireContext(brian, event.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    const result = await invitations.acceptInvitation(brian, invite.token);
    expect(result.role).toBe(EventRole.COORDINATOR);
    expect(result.alreadyMember).toBe(false);

    // Now he IS an active member with the invited role and invited_by recorded.
    const brianCtx = await membership.requireContext(brian, event.id);
    expect(brianCtx.role).toBe(EventRole.COORDINATOR);
    // event_member is RLS-scoped — read it within the event's tenant scope.
    const member = await tenant.runInEvent(event.id, (tx) =>
      tx.eventMember.findFirst({
        where: { eventId: event.id, userId: brian.userId },
        select: { status: true, invitedById: true },
      }),
    );
    expect(member?.status).toBe('ACTIVE');
    expect(member?.invitedById).toBe(owner.userId);

    // Single-use token is now consumed.
    const after = await invitations.getByToken(invite.token);
    expect(after.status).toBe(InvitationStatus.ACCEPTED);
    expect(after.valid).toBe(false);
  });

  it('accept is idempotent: an already-active member re-accepting is a no-op success', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Idempotent' });
    await grantSeats(event.id);
    const ownerCtx = await ctxFor(owner, event.id);
    // Multi-use so the second accept is not blocked by use-count.
    const invite = await invitations.createInvitation(ownerCtx, {
      role: EventRole.FINANCE,
      maxUses: 5,
    });

    const mary = await makeUser();
    const first = await invitations.acceptInvitation(mary, invite.token);
    expect(first.alreadyMember).toBe(false);
    const second = await invitations.acceptInvitation(mary, invite.token);
    expect(second.alreadyMember).toBe(true);

    // Only one use consumed despite two accepts.
    const inv = await prisma.invitation.findUnique({
      where: { token: invite.token },
      select: { uses: true },
    });
    expect(inv?.uses).toBe(1);
  });

  it('a revoked invitation cannot be accepted', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Revoke' });
    await grantSeats(event.id);
    const ownerCtx = await ctxFor(owner, event.id);
    const invite = await invitations.createInvitation(ownerCtx, { role: EventRole.VIEWER });
    const inviteRow = await prisma.invitation.findUnique({
      where: { token: invite.token },
      select: { id: true },
    });
    await invitations.revokeInvitation(ownerCtx, inviteRow!.id);

    const stranger = await makeUser();
    await expect(invitations.acceptInvitation(stranger, invite.token)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('a non-owner cannot create invitations (member:manage is owner/co-owner only)', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Perms' });
    await grantSeats(event.id);
    const ownerCtx = await ctxFor(owner, event.id);

    const finance = await makeUser();
    await membership.addMember(ownerCtx, finance.userId, EventRole.FINANCE);
    const financeCtx = await ctxFor(finance, event.id);

    await expect(
      invitations.createInvitation(financeCtx, { role: EventRole.VIEWER }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // A CO_OWNER, however, may invite.
    const sarah = await makeUser();
    await membership.addMember(ownerCtx, sarah.userId, EventRole.CO_OWNER);
    const sarahCtx = await ctxFor(sarah, event.id);
    await expect(
      invitations.createInvitation(sarahCtx, { role: EventRole.VIEWER }),
    ).resolves.toBeDefined();
  });

  it('Person↔User linkage is duplicate-safe: one person per user per event, idempotent', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Linkage' });
    const ctx = await ctxFor(owner, event.id);

    const john = await people.createPerson(ctx, { displayName: 'John Okello' });
    expect(john.userId).toBeNull(); // unclaimed contributor

    const johnUser = await makeUser();
    const linked = await people.linkPersonToUser(ctx, john.id, johnUser.userId);
    expect(linked.userId).toBe(johnUser.userId);

    // Idempotent: re-linking the same user is a no-op success.
    await expect(people.linkPersonToUser(ctx, john.id, johnUser.userId)).resolves.toMatchObject({
      userId: johnUser.userId,
    });

    // Linking that same user to a DIFFERENT person in the event is rejected
    // (the @@unique([eventId, userId]) guard → no duplicate identity).
    const otherPerson = await people.createPerson(ctx, { displayName: 'John (dup)' });
    await expect(
      people.linkPersonToUser(ctx, otherPerson.id, johnUser.userId),
    ).rejects.toBeInstanceOf(ConflictException);

    // Linking an already-claimed person to a different user is rejected.
    const someoneElse = await makeUser();
    await expect(people.linkPersonToUser(ctx, john.id, someoneElse.userId)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('many unclaimed contributors coexist (NULL user_id is not deduped)', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Many contributors' });
    const ctx = await ctxFor(owner, event.id);
    for (let i = 0; i < 5; i++) {
      await people.createPerson(ctx, { displayName: `Contributor ${i}` });
    }
    const list = await people.listPeople(ctx);
    expect(list).toHaveLength(5);
    expect(list.every((p) => p.userId === null)).toBe(true);
  });
});
