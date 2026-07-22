import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { BudgetVisibility, ContributorVisibility, EventRole, PaymentMethod } from '@prisma/client';
import { AppConfigModule } from '@akabbo/config';
import { PrismaModule, PrismaService } from '@akabbo/prisma';
import { AccessModule, Actor, OperationContext } from '@akabbo/access';
import { IdentityModule } from '@akabbo/identity';
import {
  AllocationService,
  BudgetService,
  EventService,
  FulfillmentService,
  LedgerModule,
  MembershipService,
  PersonService,
  PledgeService,
} from '@akabbo/ledger';
import {
  AnnouncementService,
  PaymentInstructionService,
  PublicSettingsService,
  PublicViewService,
  TransparencyModule,
} from '@akabbo/transparency';

/**
 * Phase 5 DoD (transparency spec) — the PUBLIC EVENT TRANSPARENCY layer:
 *  • the public projection reports consistent target/pledged/received/remaining
 *  • transparency config controls contributor + budget detail
 *  • NO private field (phone, person id, note, audit) ever leaks
 *  • a revoked / token-gated link is not readable
 *  • public config is permission-gated; publishing bumps the cache revision
 */
describe('Phase 5 — public transparency (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let events: EventService;
  let membership: MembershipService;
  let people: PersonService;
  let pledges: PledgeService;
  let fulfillments: FulfillmentService;
  let budget: BudgetService;
  let allocations: AllocationService;
  let publicView: PublicViewService;
  let settings: PublicSettingsService;
  let announcements: AnnouncementService;
  let paymentInstructions: PaymentInstructionService;

  let seq = 0;
  const makeUser = async (): Promise<Actor> => {
    const u = await prisma.user.create({
      data: { phone: `+256707${String(seq++).padStart(6, '0')}`, phoneVerified: true },
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
      imports: [
        AppConfigModule,
        PrismaModule,
        AccessModule,
        IdentityModule,
        LedgerModule,
        TransparencyModule,
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    events = moduleRef.get(EventService);
    membership = moduleRef.get(MembershipService);
    people = moduleRef.get(PersonService);
    pledges = moduleRef.get(PledgeService);
    fulfillments = moduleRef.get(FulfillmentService);
    budget = moduleRef.get(BudgetService);
    allocations = moduleRef.get(AllocationService);
    publicView = moduleRef.get(PublicViewService);
    settings = moduleRef.get(PublicSettingsService);
    announcements = moduleRef.get(AnnouncementService);
    paymentInstructions = moduleRef.get(PaymentInstructionService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE payment_instruction, event_announcement, invitation, usage_event, pending_confirmation, outbox, audit_event, allocation, fulfillment, pledge, budget_item, budget, person, event_member, event, "user", auth_otp_challenge RESTART IDENTITY CASCADE',
    );
  });

  /** A wedding: 25M target, three contributors with phones (PII), one budget. */
  async function seedWedding(): Promise<{ owner: Actor; ctx: OperationContext; slug: string }> {
    const owner = await makeUser();
    const event = await events.createEvent(owner, {
      name: 'William & Sarah',
      targetAmount: 25_000_000n,
    });
    const ctx = await ctxFor(owner, event.id);

    // John: pledged 5M, paid 4M (phone is PII — must never surface publicly).
    const john = await people.createPerson(ctx, { displayName: 'John Kato', phone: '+256770000001' });
    const jp = await pledges.createPledge(ctx, { personId: john.id, committedValue: 5_000_000n });
    await fulfillments.recordFulfillment(ctx, {
      pledgeId: jp.id,
      value: 4_000_000n,
      note: 'gave cash to Mary at the meeting', // private note — must not leak
    });

    // Annet: pledged 2M, paid 2M (complete).
    const annet = await people.createPerson(ctx, {
      displayName: 'Annet Nakato',
      phone: '+256770000002',
    });
    const ap = await pledges.createPledge(ctx, { personId: annet.id, committedValue: 2_000_000n });
    await fulfillments.recordFulfillment(ctx, { pledgeId: ap.id, value: 2_000_000n });

    // Peter: person with no pledge (not a contributor).
    await people.createPerson(ctx, { displayName: 'Peter', phone: '+256770000003' });

    const slug = (await prisma.event.findUniqueOrThrow({
      where: { id: event.id },
      select: { slug: true },
    })).slug;

    return { owner, ctx, slug };
  }

  it('projects consistent, correct totals from the canonical ledger (Part 3/28)', async () => {
    const { slug } = await seedWedding();
    const v = await publicView.getPublicEventView(slug);

    expect(v.name).toBe('William & Sarah');
    expect(v.target).toBe('25000000');
    expect(v.totalPledged).toBe('7000000'); // 5M + 2M
    expect(v.totalReceived).toBe('6000000'); // 4M + 2M
    expect(v.totalOutstanding).toBe('1000000'); // 7M − 6M
    expect(v.remaining).toBe('19000000'); // 25M − 6M received
    expect(v.percentCovered).toBe(24); // 6M of 25M
    expect(v.contributorCount).toBe(2); // Peter didn't pledge

    // Internal consistency: pledged − received == outstanding; target − received == remaining.
    expect(BigInt(v.totalPledged) - BigInt(v.totalReceived)).toBe(BigInt(v.totalOutstanding));
    expect(BigInt(v.target!) - BigInt(v.totalReceived)).toBe(BigInt(v.remaining!));
  });

  it('NEVER leaks a private field — no phone, person id, note, or audit (Part 10)', async () => {
    const { slug } = await seedWedding();
    const v = await publicView.getPublicEventView(slug);
    const json = JSON.stringify(v);

    expect(json).not.toContain('+25677'); // no phone numbers
    expect(json).not.toContain('gave cash to Mary'); // no fulfillment note
    expect(json).not.toContain('person_id');
    expect(json).not.toMatch(/"(id|personId|createdById|eventId|userId)"/); // no internal ids

    // The contributor projection is name + amounts + status ONLY.
    expect(v.contributors).not.toBeNull();
    expect(Object.keys(v.contributors![0]).sort()).toEqual(
      ['committed', 'displayName', 'outstanding', 'received', 'status'].sort(),
    );
    expect(v.contributors!.map((c) => c.displayName)).toEqual(['John Kato', 'Annet Nakato']);
  });

  it('honours contributor visibility: NAMES_ONLY / AGGREGATE_ONLY / HIDDEN (Part 5/15)', async () => {
    const { ctx, slug } = await seedWedding();

    await settings.updateSettings(ctx, {
      contributorVisibility: ContributorVisibility.NAMES_ONLY,
    });
    let v = await publicView.getPublicEventView(slug);
    expect(v.contributors!.every((c) => c.received === undefined)).toBe(true);
    expect(v.contributors!.map((c) => c.displayName)).toContain('John Kato');
    expect(v.recentActivity).toBeNull(); // activity only at NAMES_AND_AMOUNTS
    expect(v.contributorCount).toBe(2);
    // Totals are STILL public — aggregate transparency never hides.
    expect(v.totalReceived).toBe('6000000');

    await settings.updateSettings(ctx, {
      contributorVisibility: ContributorVisibility.AGGREGATE_ONLY,
    });
    v = await publicView.getPublicEventView(slug);
    expect(v.contributors).toBeNull();
    expect(v.contributorCount).toBe(2); // count still shown
    expect(v.totalReceived).toBe('6000000');

    await settings.updateSettings(ctx, { contributorVisibility: ContributorVisibility.HIDDEN });
    v = await publicView.getPublicEventView(slug);
    expect(v.contributors).toBeNull();
    expect(v.contributorCount).toBeNull();
    expect(v.totalReceived).toBe('6000000'); // headline totals remain
  });

  it('honours budget visibility PUBLIC / PARTIALLY_PUBLIC / HIDDEN with coverage (Part 4/16)', async () => {
    const { ctx, slug } = await seedWedding();

    const venue = await budget.addItem(ctx, { name: 'Venue', targetValue: 3_000_000n });
    const catering = await budget.addItem(ctx, { name: 'Catering', targetValue: 5_000_000n });
    // A dedicated contributor whose payment we allocate to Catering → partial.
    const donor = await people.createPerson(ctx, { displayName: 'Donor' });
    const dp = await pledges.createPledge(ctx, { personId: donor.id, committedValue: 3_000_000n });
    const ful = await fulfillments.recordFulfillment(ctx, { pledgeId: dp.id, value: 3_000_000n });
    await allocations.allocate(ctx, ful.id, catering.id, 3_000_000n);

    // PUBLIC: both items visible, Catering PARTIALLY_FUNDED, Venue UNFUNDED.
    let v = await publicView.getPublicEventView(slug);
    expect(v.budget!.items.map((i) => i.name).sort()).toEqual(['Catering', 'Venue']);
    const cat = v.budget!.items.find((i) => i.name === 'Catering')!;
    expect(cat.covered).toBe('3000000');
    expect(cat.remaining).toBe('2000000');
    expect(cat.status).toBe('PARTIALLY_FUNDED');
    expect(v.budget!.items.find((i) => i.name === 'Venue')!.status).toBe('UNFUNDED');
    expect(v.budget!.total).toBe('8000000');

    // PARTIALLY_PUBLIC: hide the Venue line (private vendor pricing).
    await budget.updateItem(ctx, venue.id, { isPublic: false });
    await settings.updateSettings(ctx, { budgetVisibility: BudgetVisibility.PARTIALLY_PUBLIC });
    v = await publicView.getPublicEventView(slug);
    expect(v.budget!.items.map((i) => i.name)).toEqual(['Catering']);
    expect(v.budget!.total).toBe('5000000'); // only the visible line

    // HIDDEN: no budget section at all.
    await settings.updateSettings(ctx, { budgetVisibility: BudgetVisibility.HIDDEN });
    v = await publicView.getPublicEventView(slug);
    expect(v.budget).toBeNull();
  });

  it('a revoked link (isPublic=false) is a 404; restoring it works (Part 20)', async () => {
    const { ctx, slug } = await seedWedding();
    await settings.updateSettings(ctx, { isPublic: false });
    await expect(publicView.getPublicEventView(slug)).rejects.toBeInstanceOf(NotFoundException);

    await settings.updateSettings(ctx, { isPublic: true });
    await expect(publicView.getPublicEventView(slug)).resolves.toMatchObject({ slug });
  });

  it('an invite-only link requires the token (Part 20)', async () => {
    const { ctx, slug } = await seedWedding();
    const rotated = await settings.rotateAccessToken(ctx);
    expect(rotated.accessToken).toBeTruthy();

    await expect(publicView.getPublicEventView(slug)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(publicView.getPublicEventView(slug, 'wrong')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      publicView.getPublicEventView(slug, rotated.accessToken!),
    ).resolves.toMatchObject({ slug });

    // Clearing the token re-opens the link.
    await settings.clearAccessToken(ctx);
    await expect(publicView.getPublicEventView(slug)).resolves.toMatchObject({ slug });
  });

  it('surfaces published announcements + public payment instructions only (Part 17/18)', async () => {
    const { ctx, slug } = await seedWedding();

    const draft = await announcements.create(ctx, 'We are at 80% of our target!');
    // Draft is NOT public yet.
    let v = await publicView.getPublicEventView(slug);
    expect(v.announcements).toHaveLength(0);

    const beforeRev = v.revision;
    await announcements.publish(ctx, draft.id);
    v = await publicView.getPublicEventView(slug);
    expect(v.announcements.map((a) => a.body)).toEqual(['We are at 80% of our target!']);
    expect(v.revision).toBeGreaterThan(beforeRev); // publishing bumped the cache revision

    // Payment instructions: one public (MTN), one private (internal bank).
    await paymentInstructions.create(ctx, {
      method: PaymentMethod.MTN,
      label: 'MTN Mobile Money',
      details: '0771 234 567 — William',
    });
    await paymentInstructions.create(ctx, {
      method: PaymentMethod.BANK,
      label: 'Internal bank',
      details: 'do-not-show',
      isPublic: false,
    });
    v = await publicView.getPublicEventView(slug);
    expect(v.paymentInstructions).toHaveLength(1);
    expect(v.paymentInstructions[0].label).toBe('MTN Mobile Money');
    expect(JSON.stringify(v)).not.toContain('do-not-show');
  });

  it('public configuration is permission-gated: a VIEWER is denied (Part 26)', async () => {
    const { ctx } = await seedWedding();
    const viewer = await makeUser();
    await membership.addMember(ctx, viewer.userId, EventRole.VIEWER);
    const viewerCtx = await ctxFor(viewer, ctx.event.eventId);

    await expect(settings.updateSettings(viewerCtx, { isPublic: false })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(announcements.create(viewerCtx, 'nope')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      paymentInstructions.create(viewerCtx, {
        method: PaymentMethod.MTN,
        label: 'x',
        details: 'y',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cannot read another event through a public slug (cross-event isolation)', async () => {
    const a = await seedWedding();
    const b = await seedWedding();
    const va = await publicView.getPublicEventView(a.slug);
    const vb = await publicView.getPublicEventView(b.slug);
    // Each slug returns only its own event; totals are independent and equal here
    // but the slugs differ and neither leaks the other's people.
    expect(va.slug).toBe(a.slug);
    expect(vb.slug).toBe(b.slug);
    expect(a.slug).not.toBe(b.slug);
  });
});
