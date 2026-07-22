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
  PersonService,
  PledgeService,
} from '@akabbo/ledger';
import { ProvidersModule } from '@akabbo/providers';
import {
  AiModule,
  AssistantService,
  ConfirmationService,
  ConversationOrchestrator,
} from '@akabbo/ai';

/**
 * LIVE end-to-end test against the REAL Gemini API — proves the multi-turn
 * tool-use loop works with the actual model (not a mock). Gated on
 * GEMINI_API_KEY so normal/CI runs stay offline. Run with:
 *
 *   GEMINI_API_KEY=... GEMINI_MODEL=gemini-flash-latest \
 *   DATABASE_URL=... DIRECT_URL=... NODE_ENV=test JWT_SECRET=... \
 *   pnpm test -- test/live-gemini.e2e.spec.ts
 *
 * Assertions are mostly DB-based (robust to LLM phrasing); replies are logged so
 * the real interaction is visible.
 */
const LIVE = Boolean(process.env.GEMINI_API_KEY);
if (LIVE) {
  process.env.LLM_PROVIDER = 'gemini';
  // `gemini-2.5-flash` is now 404 "no longer available to new users"; the
  // current alias is the working choice (transient 503s handled by adapter retry).
  process.env.GEMINI_MODEL ??= 'gemini-flash-latest';
}

(LIVE ? describe : describe.skip)('LIVE — Akabbo AI against real Gemini (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let events: EventService;
  let membership: MembershipService;
  let people: PersonService;
  let pledges: PledgeService;
  let fulfillments: FulfillmentService;
  let assistant: AssistantService;
  let orchestrator: ConversationOrchestrator;
  let confirmations: ConfirmationService;

  let seq = 0;
  const makeUser = async (): Promise<Actor> => {
    const u = await prisma.user.create({
      data: { phone: `+256799${String(seq++).padStart(6, '0')}`, phoneVerified: true },
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
        AiModule,
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    events = moduleRef.get(EventService);
    membership = moduleRef.get(MembershipService);
    people = moduleRef.get(PersonService);
    pledges = moduleRef.get(PledgeService);
    fulfillments = moduleRef.get(FulfillmentService);
    assistant = moduleRef.get(AssistantService);
    orchestrator = moduleRef.get(ConversationOrchestrator);
    confirmations = moduleRef.get(ConfirmationService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE person_group, contributor_group, message, conversation, payment_instruction, event_announcement, invitation, usage_event, pending_confirmation, outbox, audit_event, allocation, fulfillment, pledge, budget_item, budget, person, event_member, event, "user", auth_otp_challenge RESTART IDENTITY CASCADE',
    );
  });

  async function seedWedding(): Promise<{ owner: Actor; ctx: OperationContext }> {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Live Wedding', targetAmount: 25_000_000n });
    const ctx = await ctxFor(owner, event.id);
    const john = await people.createPerson(ctx, { displayName: 'John Kato' });
    const jp = await pledges.createPledge(ctx, { personId: john.id, committedValue: 5_000_000n });
    await fulfillments.recordFulfillment(ctx, { pledgeId: jp.id, value: 4_000_000n });
    const peter = await people.createPerson(ctx, { displayName: 'Peter' });
    await pledges.createPledge(ctx, { personId: peter.id, committedValue: 1_000_000n });
    return { owner, ctx };
  }

  it(
    'answers "how are we doing?" from real grounded tools',
    async () => {
      const { ctx } = await seedWedding();
      const res = await assistant.chat(ctx, 'How are we doing? Include the exact UGX received.');
      // eslint-disable-next-line no-console
      console.log('\n[LIVE overview] steps=%d reply=%s', res.steps, res.reply);
      expect(res.steps).toBeGreaterThanOrEqual(2); // tool call → grounded answer
      expect(res.reply.length).toBeGreaterThan(0);
      // The grounded received figure (4,000,000) should surface in some form.
      expect(res.reply).toMatch(/4[.,\s]?0{0,3}[.,\s]?0{0,3}|4\s*(m|million)/i);
    },
    60_000,
  );

  it(
    'answers "who hasn\'t paid?" and names Peter',
    async () => {
      const { ctx } = await seedWedding();
      const res = await assistant.chat(ctx, "Who hasn't paid anything yet?");
      // eslint-disable-next-line no-console
      console.log('\n[LIVE unpaid] reply=%s', res.reply);
      expect(res.reply).toMatch(/peter/i);
    },
    60_000,
  );

  it(
    'creates an event from natural language via the conversation entry',
    async () => {
      const owner = await makeUser();
      const res = await orchestrator.converse(
        owner,
        'Create a wedding event called "Brian and Mary" with a target of 10 million UGX.',
      );
      // eslint-disable-next-line no-console
      console.log('\n[LIVE create] activeEvent=%s reply=%s', res.activeEventId, res.reply);
      expect(res.activeEventId).toBeTruthy();
      const created = await prisma.event.findFirstOrThrow({
        where: { ownerUserId: owner.userId },
        select: { name: true, targetAmount: true },
      });
      expect(created.name.toLowerCase()).toContain('brian');
      expect(created.targetAmount).toBe(10_000_000n);
    },
    60_000,
  );

  it(
    'stages a payment write for confirmation (never auto-commits)',
    async () => {
      const { ctx } = await seedWedding();
      const res = await assistant.chat(ctx, 'Record that Peter has paid 1,000,000.');
      // eslint-disable-next-line no-console
      console.log('\n[LIVE write] staged=%o reply=%s', res.staged, res.reply);
      const pending = await confirmations.listPending(ctx);
      expect(pending.length).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );
});
