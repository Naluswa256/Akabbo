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
import { AiModule, AssistantService, ConfirmationService } from '@akabbo/ai';

/**
 * AI operating-layer DoD (product spec Part 1/2/15/23/24):
 *  • the agent ANSWERS from grounded tools (never invents numbers)
 *  • it ACTS via write tools that STAGE a pending confirmation (human-in-loop)
 *  • an ambiguous name is disambiguated, never guessed
 *  • the loop feeds tool results back to the model across turns
 *  • a read the caller isn't allowed → surfaced, not leaked
 */

/**
 * Scripted LLM: each `chat` turn consumes queued steps in order. A step is
 * either a tool call (the model asking to run a tool) or final text. This lets
 * us drive the multi-turn tool loop deterministically and assert that the tool
 * RESULT was fed back on the following request.
 */
class ScriptedLlm {
  readonly name = 'scripted';
  private steps: LlmCompletionResult[] = [];
  requests: LlmCompletionRequest[] = [];

  queueToolCall(name: string, args: Record<string, unknown>): void {
    this.steps.push({
      toolCalls: [{ id: `c${this.steps.length}`, name, arguments: args }],
      usage: { inputTokens: 100, outputTokens: 20, model: 'scripted' },
    });
  }

  queueText(text: string): void {
    this.steps.push({
      toolCalls: [],
      text,
      usage: { inputTokens: 100, outputTokens: 20, model: 'scripted' },
    });
  }

  complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    this.requests.push(req);
    const next = this.steps.shift();
    if (!next) throw new Error('ScriptedLlm ran out of steps');
    return Promise.resolve(next);
  }
}

describe('AI operating layer — assistant agent (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let events: EventService;
  let membership: MembershipService;
  let people: PersonService;
  let pledges: PledgeService;
  let fulfillments: FulfillmentService;
  let assistant: AssistantService;
  let confirmations: ConfirmationService;
  const llm = new ScriptedLlm();

  let seq = 0;
  const makeUser = async (): Promise<Actor> => {
    const u = await prisma.user.create({
      data: { phone: `+256709${String(seq++).padStart(6, '0')}`, phoneVerified: true },
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
        ProvidersModule,
        AccessModule,
        IdentityModule,
        LedgerModule,
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
    assistant = moduleRef.get(AssistantService);
    confirmations = moduleRef.get(ConfirmationService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    llm.requests = [];
    await prisma.$executeRawUnsafe(
      'TRUNCATE payment_instruction, event_announcement, invitation, usage_event, pending_confirmation, outbox, audit_event, allocation, fulfillment, pledge, budget_item, budget, person, event_member, event, "user", auth_otp_challenge RESTART IDENTITY CASCADE',
    );
  });

  async function seedWedding(): Promise<{ owner: Actor; ctx: OperationContext; eventId: string }> {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Wedding', targetAmount: 25_000_000n });
    const ctx = await ctxFor(owner, event.id);
    // John: pledged 5M, paid 4M. Annet: pledged 2M, paid 2M. Peter: pledged 1M, paid 0.
    const john = await people.createPerson(ctx, { displayName: 'John Kato' });
    const jp = await pledges.createPledge(ctx, { personId: john.id, committedValue: 5_000_000n });
    await fulfillments.recordFulfillment(ctx, { pledgeId: jp.id, value: 4_000_000n });
    const annet = await people.createPerson(ctx, { displayName: 'Annet' });
    const ap = await pledges.createPledge(ctx, { personId: annet.id, committedValue: 2_000_000n });
    await fulfillments.recordFulfillment(ctx, { pledgeId: ap.id, value: 2_000_000n });
    const peter = await people.createPerson(ctx, { displayName: 'Peter' });
    await pledges.createPledge(ctx, { personId: peter.id, committedValue: 1_000_000n });
    return { owner, ctx, eventId: event.id };
  }

  it('answers "how are we doing?" from the grounded overview tool (Part 15)', async () => {
    const { ctx } = await seedWedding();
    llm.queueToolCall('get_event_overview', {});
    llm.queueText('You have received UGX 6,000,000 of your UGX 25,000,000 target — 24% funded.');

    const res = await assistant.chat(ctx, 'How are we doing?');

    expect(res.reply).toContain('6,000,000');
    // Two model calls: the tool request, then the grounded answer.
    expect(llm.requests).toHaveLength(2);
    // The tool RESULT was fed back on the 2nd request (the loop closed).
    const secondReqToolTurn = llm.requests[1].messages.find((m) => m.role === 'tool');
    expect(secondReqToolTurn?.toolResults?.[0]?.name).toBe('get_event_overview');
    expect(secondReqToolTurn?.toolResults?.[0]?.content).toContain('6000000');
  });

  it('lists who hasn\'t paid using the unpaid filter (Part 10)', async () => {
    const { ctx } = await seedWedding();
    llm.queueToolCall('list_contributors', { status: 'unpaid' });
    llm.queueText('One person has pledged but paid nothing: Peter (UGX 1,000,000 outstanding).');

    const res = await assistant.chat(ctx, "Who hasn't paid?");

    expect(res.reply).toContain('Peter');
    const toolTurn = llm.requests[1].messages.find((m) => m.role === 'tool');
    const payload = JSON.parse(toolTurn!.toolResults![0].content);
    expect(payload.count).toBe(1);
    expect(payload.contributors[0].displayName).toBe('Peter');
    expect(payload.interpretation).toContain('paid nothing');
  });

  it('stages a write (record_payment) as a pending confirmation — never auto-commits (Part 24)', async () => {
    const { ctx, eventId } = await seedWedding();
    llm.queueToolCall('record_payment', { personName: 'Peter', amount: '500k' });
    llm.queueText("I've staged a UGX 500,000 payment from Peter — confirm to record it.");

    const res = await assistant.chat(ctx, 'Peter sent 500k');

    // Exactly one pending confirmation was staged; nothing committed yet.
    expect(res.staged).toHaveLength(1);
    const pending = await confirmations.listPending(ctx);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(res.staged[0]);
    expect(pending[0].intent).toBe('record_payment');
    expect(eventId).toBeTruthy();
  });

  it('disambiguates an ambiguous name instead of guessing (Part 5/27)', async () => {
    const { ctx } = await seedWedding();
    // Add a second John so "John" is ambiguous.
    await people.createPerson(ctx, { displayName: 'John Mugisha' });

    llm.queueToolCall('find_contributor', { name: 'John' });
    // The model, seeing candidates, asks which one (we assert the tool result).
    llm.queueText('There are two Johns — John Kato or John Mugisha. Which one?');

    const res = await assistant.chat(ctx, 'How much has John contributed?');

    const toolTurn = llm.requests[1].messages.find((m) => m.role === 'tool');
    const payload = JSON.parse(toolTurn!.toolResults![0].content);
    expect(payload.status).toBe('ambiguous');
    expect(payload.candidates.map((c: { displayName: string }) => c.displayName).sort()).toEqual([
      'John Kato',
      'John Mugisha',
    ]);
    expect(res.reply).toContain('Which one');
  });

  it('tells the truth when data is missing rather than inventing (Part 32)', async () => {
    const { ctx } = await seedWedding();
    llm.queueToolCall('find_contributor', { name: 'Nobody' });
    llm.queueText("I don't have anyone named Nobody in this event yet.");

    const res = await assistant.chat(ctx, 'How much has Nobody contributed?');

    const toolTurn = llm.requests[1].messages.find((m) => m.role === 'tool');
    const payload = JSON.parse(toolTurn!.toolResults![0].content);
    expect(payload.status).toBe('not_found');
    expect(res.reply.toLowerCase()).toContain("don't have");
  });

  it('does multi-step reasoning: overview then budget in one turn (Part 16)', async () => {
    const { ctx } = await seedWedding();
    llm.queueToolCall('get_event_overview', {});
    llm.queueToolCall('get_budget', {});
    llm.queueText('You are 24% funded; your budget has no items yet, so nothing is allocated.');

    const res = await assistant.chat(ctx, 'What should I focus on?');

    expect(res.steps).toBe(3); // overview → budget → answer
    expect(res.reply).toContain('24%');
    // The final request carries the full transcript: both tool results, in order.
    const finalReq = llm.requests[llm.requests.length - 1];
    const names = finalReq.messages
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.toolResults ?? [])
      .map((t) => t.name);
    expect(names).toEqual(['get_event_overview', 'get_budget']);
  });

  it('surfaces permission denial instead of leaking (a VIEWER cannot read amounts)', async () => {
    const { ctx } = await seedWedding();
    const viewer = await makeUser();
    await membership.addMember(ctx, viewer.userId, EventRole.VIEWER);
    const viewerCtx = await ctxFor(viewer, ctx.event.eventId);

    llm.queueToolCall('get_event_overview', {});
    llm.queueText("You don't have access to contribution amounts on this event.");

    await assistant.chat(viewerCtx, 'How much have we raised?');

    const toolTurn = llm.requests[1].messages.find((m) => m.role === 'tool');
    const payload = JSON.parse(toolTurn!.toolResults![0].content);
    expect(payload.error).toBe('permission_denied');
  });
});
