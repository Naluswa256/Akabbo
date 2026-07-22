import { Test, TestingModule } from '@nestjs/testing';
import { AnnouncementStatus } from '@prisma/client';
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
import {
  LLM_PROVIDER,
  LlmCompletionRequest,
  LlmCompletionResult,
  ProvidersModule,
} from '@akabbo/providers';
import { AnnouncementService, TransparencyModule } from '@akabbo/transparency';
import { BillingService } from '@akabbo/billing';
import { AiModule, AssistantService, ConfirmationService } from '@akabbo/ai';

/**
 * AI-increment Phase 4 DoD (next-increment §5/§6): the SIDE-EFFECT tier —
 * announcements (draft → publish) and reminders. The AI never claims a message
 * was delivered; sending is gated on the (unbuilt) messaging layer.
 */
class ScriptedLlm {
  readonly name = 'scripted';
  private steps: LlmCompletionResult[] = [];
  complete(_r: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const n = this.steps.shift();
    if (!n) throw new Error('out of steps');
    return Promise.resolve(n);
  }
  tool(name: string, args: Record<string, unknown> = {}): void {
    this.steps.push({
      toolCalls: [{ id: `c${this.steps.length}`, name, arguments: args }],
      usage: { inputTokens: 40, outputTokens: 8, model: 'scripted' },
    });
  }
  text(t: string): void {
    this.steps.push({ toolCalls: [], text: t, usage: { inputTokens: 40, outputTokens: 8, model: 'scripted' } });
  }
}

describe('AI operating layer — Phase 4 side effects (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let events: EventService;
  let membership: MembershipService;
  let people: PersonService;
  let pledges: PledgeService;
  let fulfillments: FulfillmentService;
  let announcements: AnnouncementService;
  let assistant: AssistantService;
  const llm = new ScriptedLlm();

  let seq = 0;
  const makeUser = async (): Promise<Actor> => {
    const u = await prisma.user.create({
      data: { phone: `+256713${String(seq++).padStart(6, '0')}`, phoneVerified: true },
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
        TransparencyModule,
        AiModule,
      ],
    })
      .overrideProvider(LLM_PROVIDER)
      .useValue(llm)
      .compile();
    prisma = moduleRef.get(PrismaService);
    events = moduleRef.get(EventService);
    membership = moduleRef.get(MembershipService);
    people = moduleRef.get(PersonService);
    pledges = moduleRef.get(PledgeService);
    fulfillments = moduleRef.get(FulfillmentService);
    announcements = moduleRef.get(AnnouncementService);
    assistant = moduleRef.get(AssistantService);
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

  it('drafts an announcement then publishes it to the public page (§6)', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Wedding', targetAmount: 10_000_000n });
    const ctx = await ctxFor(owner, event.id);

    llm.tool('draft_announcement', { body: 'We have reached 80% of our target!' });
    llm.text('Drafted it — review then publish.');
    await assistant.chat(ctx, "Tell everyone we've reached 80%");

    // A DRAFT exists but nothing is public yet.
    let all = await announcements.list(ctx);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe(AnnouncementStatus.DRAFT);
    const draftId = all[0].id;

    // The organizer publishes it (the side effect).
    llm.tool('publish_announcement', { announcementId: draftId });
    llm.text('Published to the public page.');
    await assistant.chat(ctx, 'Publish it');

    all = await announcements.list(ctx);
    expect(all[0].status).toBe(AnnouncementStatus.PUBLISHED);
    expect(all[0].source).toBe('ai_from_chat');
  });

  it('stages a reminder blast for confirmation — never sends without approval (§6, Part 24)', async () => {
    const billing = moduleRef.get(BillingService);
    const confirmations = moduleRef.get(ConfirmationService);
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Reminders' });
    const ctx = await ctxFor(owner, event.id);
    // Two people (with phones) owe money, one is fully paid.
    const a = await people.createPerson(ctx, { displayName: 'A', phone: '+256770000001' });
    const ap = await pledges.createPledge(ctx, { personId: a.id, committedValue: 500_000n });
    await fulfillments.recordFulfillment(ctx, { pledgeId: ap.id, value: 100_000n }); // outstanding
    const b = await people.createPerson(ctx, { displayName: 'B', phone: '+256770000002' });
    await pledges.createPledge(ctx, { personId: b.id, committedValue: 300_000n }); // outstanding, unpaid
    const c = await people.createPerson(ctx, { displayName: 'C', phone: '+256770000003' });
    const cp = await pledges.createPledge(ctx, { personId: c.id, committedValue: 200_000n });
    await fulfillments.recordFulfillment(ctx, { pledgeId: cp.id, value: 200_000n }); // paid in full
    await billing.grantCredits({ eventId: event.id }, 10, `seed:${event.id}`);

    let captured: { status?: string } = {};
    const origComplete = llm.complete.bind(llm);
    llm.complete = (req: LlmCompletionRequest) => {
      const toolTurn = req.messages.find((m) => m.role === 'tool');
      if (toolTurn?.toolResults?.[0]?.name === 'send_reminders') {
        captured = JSON.parse(toolTurn.toolResults[0].content);
      }
      return origComplete(req);
    };

    llm.tool('send_reminders', { body: 'Hi {name}, please clear your pledge.' });
    llm.text('I have staged a reminder to 2 outstanding contributors — confirm to send.');
    const res = await assistant.chat(ctx, "Remind everyone who hasn't paid");

    // Staged, not sent: a pending confirmation exists, no campaign queued yet.
    expect(captured.status).toBe('staged');
    expect(res.staged).toHaveLength(1);
    const pending = await confirmations.listPending(ctx);
    expect(pending[0].intent).toBe('send_sms_reminders');
    const outbox = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
      `SELECT count(*)::int AS c FROM outbox WHERE topic LIKE 'sms%'`,
    );
    expect(Number(outbox[0].c)).toBe(0);
  });
});
