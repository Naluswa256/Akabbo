import { Test, TestingModule } from '@nestjs/testing';
import { AppConfigModule } from '@akabbo/config';
import { PrismaModule, PrismaService } from '@akabbo/prisma';
import { AccessModule, Actor } from '@akabbo/access';
import { IdentityModule } from '@akabbo/identity';
import { EventService, LedgerModule } from '@akabbo/ledger';
import {
  LLM_PROVIDER,
  LlmCompletionRequest,
  LlmCompletionResult,
  ProvidersModule,
} from '@akabbo/providers';
import { AiModule, ConversationOrchestrator } from '@akabbo/ai';

/**
 * AI-increment Phase 1 DoD (next-increment §7/§8):
 *  • create_event via natural language (no event context yet)
 *  • active-event resolution: one event auto-selected; many → "which event?"
 *  • switch active event mid-conversation
 *  • conversation persistence: prior turns replay as context; the active event
 *    survives across turns
 */
class ScriptedLlm {
  readonly name = 'scripted';
  private steps: LlmCompletionResult[] = [];
  requests: LlmCompletionRequest[] = [];

  toolCall(name: string, args: Record<string, unknown> = {}): void {
    this.steps.push({
      toolCalls: [{ id: `c${this.steps.length}`, name, arguments: args }],
      usage: { inputTokens: 80, outputTokens: 15, model: 'scripted' },
    });
  }
  text(text: string): void {
    this.steps.push({
      toolCalls: [],
      text,
      usage: { inputTokens: 80, outputTokens: 15, model: 'scripted' },
    });
  }
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    this.requests.push(req);
    const next = this.steps.shift();
    if (!next) throw new Error('ScriptedLlm ran out of steps');
    return Promise.resolve(next);
  }
}

describe('AI operating layer — conversation + active event (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let events: EventService;
  let orchestrator: ConversationOrchestrator;
  const llm = new ScriptedLlm();

  let seq = 0;
  const makeUser = async (): Promise<Actor> => {
    const u = await prisma.user.create({
      data: { phone: `+256710${String(seq++).padStart(6, '0')}`, phoneVerified: true },
      select: { id: true },
    });
    return { userId: u.id, phoneVerified: true };
  };

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
    orchestrator = moduleRef.get(ConversationOrchestrator);
    await prisma.$connect();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    llm.requests = [];
    await prisma.$executeRawUnsafe(
      'TRUNCATE message, conversation, payment_instruction, event_announcement, invitation, usage_event, pending_confirmation, outbox, audit_event, allocation, fulfillment, pledge, budget_item, budget, person, event_member, event, "user", auth_otp_challenge RESTART IDENTITY CASCADE',
    );
  });

  it('creates an event from natural language and makes it active (§3 create_event)', async () => {
    const owner = await makeUser();
    llm.toolCall('create_event', { name: 'William & Sarah Wedding', target: '25m' });
    llm.text('Done — I created William & Sarah Wedding with a UGX 25,000,000 target.');

    const res = await orchestrator.converse(owner, "Create a wedding for William and Sarah, target 25m");

    // An event now exists, owned by the user, and is the conversation's active event.
    const created = await prisma.event.findFirstOrThrow({
      where: { ownerUserId: owner.userId },
      select: { id: true, name: true, targetAmount: true },
    });
    expect(created.name).toBe('William & Sarah Wedding');
    expect(created.targetAmount).toBe(25_000_000n);
    expect(res.activeEventId).toBe(created.id);
    expect(res.reply).toContain('25,000,000');
    // Both turns were persisted.
    const messages = await prisma.message.count({ where: { conversationId: res.conversationId } });
    expect(messages).toBe(2);
  });

  it('auto-resolves the active event when the user has exactly one', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Only Event', targetAmount: 1_000_000n });

    // No event in the conversation yet; the model switches to the only one, then reads it.
    llm.toolCall('list_my_events', {});
    llm.toolCall('switch_event', { eventId: event.id });
    llm.toolCall('get_event_overview', {});
    llm.text('Your only event has a UGX 1,000,000 target and nothing received yet.');

    const res = await orchestrator.converse(owner, 'How are we doing?');
    expect(res.activeEventId).toBe(event.id);
    expect(res.reply).toContain('1,000,000');
  });

  it('asks WHICH event when a read is attempted with no active event and several exist', async () => {
    const owner = await makeUser();
    await events.createEvent(owner, { name: 'Wedding' });
    await events.createEvent(owner, { name: 'Funeral' });

    // The model calls a read tool before selecting an event → gets no_active_event + the list.
    llm.toolCall('get_event_overview', {});
    llm.text('You manage two events — the Wedding or the Funeral. Which one should I check?');

    const res = await orchestrator.converse(owner, 'How are we doing?');

    const toolTurn = llm.requests[1].messages.find((m) => m.role === 'tool');
    const payload = JSON.parse(toolTurn!.toolResults![0].content);
    expect(payload.error).toBe('no_active_event');
    expect(payload.events.map((e: { name: string }) => e.name).sort()).toEqual([
      'Funeral',
      'Wedding',
    ]);
    expect(res.reply).toContain('Which one');
  });

  it('persists the active event and replays history across turns (§7)', async () => {
    const owner = await makeUser();
    const wedding = await events.createEvent(owner, { name: 'Wedding' });
    const funeral = await events.createEvent(owner, { name: 'Funeral' });

    // Turn 1: switch to the funeral.
    llm.toolCall('switch_event', { eventId: funeral.id });
    llm.text('Okay, we are now talking about the Funeral.');
    const first = await orchestrator.converse(owner, "Let's switch to the funeral");
    expect(first.activeEventId).toBe(funeral.id);

    // Turn 2 (same conversation): the active event PERSISTS — a read resolves to the funeral.
    llm.toolCall('get_event_overview', {});
    llm.text('The funeral collection has no target set and nothing received yet.');
    const second = await orchestrator.converse(owner, 'How are we doing?', first.conversationId);

    expect(second.activeEventId).toBe(funeral.id);
    // Turn 1 made 2 model calls (switch + reply); turn 2's first call is index 2.
    // Its transcript must REPLAY turn 1 as history (both the user line and reply).
    const turn2FirstReq = llm.requests[2];
    const contents = turn2FirstReq.messages.map((m) => m.content);
    expect(contents.some((c) => c.includes('switch to the funeral'))).toBe(true);
    expect(contents.some((c) => c.includes('now talking about the Funeral'))).toBe(true);
    // The conversation now holds 4 messages (2 turns × user+assistant).
    const count = await prisma.message.count({ where: { conversationId: first.conversationId } });
    expect(count).toBe(4);
    expect(wedding.id).not.toBe(funeral.id);
  });
});
