import { Test, TestingModule } from '@nestjs/testing';
import { AppConfigModule } from '@akabbo/config';
import { PrismaModule, PrismaService } from '@akabbo/prisma';
import { AccessModule, Actor, OperationContext } from '@akabbo/access';
import { IdentityModule } from '@akabbo/identity';
import { LedgerModule, LedgerQueryService, MembershipService } from '@akabbo/ledger';
import {
  LLM_PROVIDER,
  LlmCompletionRequest,
  LlmCompletionResult,
  ProvidersModule,
} from '@akabbo/providers';
import { AiModule, ConfirmationService, ConversationOrchestrator } from '@akabbo/ai';

/**
 * AI-increment Phase 5 DoD (next-increment §10/§11): a full conversational
 * lifecycle through the ONE user-facing entry (ConversationOrchestrator) —
 * create event → add person → pledge → payment → budget → ask "how are we
 * doing?" — with every write staged for confirmation and the canonical ledger
 * ending in the correct state.
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

describe('AI operating layer — Phase 5 end-to-end workflow (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let membership: MembershipService;
  let queries: LedgerQueryService;
  let confirmations: ConfirmationService;
  let orchestrator: ConversationOrchestrator;
  const llm = new ScriptedLlm();

  let seq = 0;
  const makeUser = async (): Promise<Actor> => {
    const u = await prisma.user.create({
      data: { phone: `+256714${String(seq++).padStart(6, '0')}`, phoneVerified: true },
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
    })
      .overrideProvider(LLM_PROVIDER)
      .useValue(llm)
      .compile();
    prisma = moduleRef.get(PrismaService);
    membership = moduleRef.get(MembershipService);
    queries = moduleRef.get(LedgerQueryService);
    confirmations = moduleRef.get(ConfirmationService);
    orchestrator = moduleRef.get(ConversationOrchestrator);
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

  it('runs the whole lifecycle in one conversation and lands correct canonical data', async () => {
    const owner = await makeUser();

    // Helper: confirm every write a turn staged, in the active event's scope.
    const confirmStaged = async (activeEventId: string, staged: string[]): Promise<void> => {
      const ctx = await ctxFor(owner, activeEventId);
      for (const id of staged) await confirmations.confirm(ctx, id);
    };

    // Turn 1 — create the event (no event context yet).
    llm.tool('create_event', { name: 'William & Sarah Wedding', target: '25m' });
    llm.text('Created William & Sarah Wedding with a 25M target.');
    const t1 = await orchestrator.converse(owner, 'Create a wedding for William and Sarah, target 25m');
    const convId = t1.conversationId;
    const eventId = t1.activeEventId!;
    expect(eventId).toBeTruthy();

    // Turn 2 — add a contributor (staged → confirm).
    llm.tool('add_person', { displayName: 'John Kato' });
    llm.text('Staged adding John Kato.');
    const t2 = await orchestrator.converse(owner, 'Add John Kato', convId);
    await confirmStaged(eventId, t2.staged);

    // Turn 3 — record his pledge.
    llm.tool('record_pledge', { personName: 'John Kato', amount: '5m' });
    llm.text('Staged a 5M pledge from John.');
    const t3 = await orchestrator.converse(owner, 'John pledged 5M', convId);
    await confirmStaged(eventId, t3.staged);

    // Turn 4 — record a payment against it.
    llm.tool('record_payment', { personName: 'John Kato', amount: '4m' });
    llm.text('Staged a 4M payment from John.');
    const t4 = await orchestrator.converse(owner, 'John paid 4M', convId);
    await confirmStaged(eventId, t4.staged);

    // Turn 5 — add a budget line.
    llm.tool('add_budget_item', { name: 'Catering', amount: '5m' });
    llm.text('Staged adding Catering at 5M.');
    const t5 = await orchestrator.converse(owner, 'Add catering at 5M', convId);
    await confirmStaged(eventId, t5.staged);

    // Turn 6 — "how are we doing?" (read; no staging).
    llm.tool('get_event_overview', {});
    llm.text('You have received UGX 4,000,000 of your 25,000,000 target — 16% funded.');
    const t6 = await orchestrator.converse(owner, 'How are we doing?', convId);
    expect(t6.staged).toHaveLength(0);
    expect(t6.reply).toContain('4,000,000');

    // The canonical ledger reflects the entire conversation.
    const ctx = await ctxFor(owner, eventId);
    const report = await queries.getEventReport(ctx);
    expect(report.target).toBe('25000000');
    expect(report.totalCommitted).toBe('5000000');
    expect(report.totalReceived).toBe('4000000');
    expect(report.totalOutstanding).toBe('1000000');
    expect(report.percentCovered).toBe(16);
    expect(report.contributorCount).toBe(1);
    expect(report.budgetTotal).toBe('5000000');

    // It was all one conversation (12 stored turns: 6 user + 6 assistant).
    const messageCount = await prisma.message.count({ where: { conversationId: convId } });
    expect(messageCount).toBe(12);
  });
});
