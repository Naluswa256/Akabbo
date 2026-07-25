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
import { BillingModule, BillingService } from '@akabbo/billing';

/**
 * Regression test for a live production incident: a user who bought AI
 * credits for a SPECIFIC EVENT (an event-scoped pack — no account-level
 * grant at all) got a hard 403 "0 AI credits remaining" on the very first
 * message of a brand-new conversation, before the AI even knew which event
 * they meant. The bare account genuinely had 0 credits; the event had 483.
 *
 * The fix: when there's no active event yet, AssistantService
 * .resolveCreditScope() checks the account first, then falls back to
 * whichever of the user's own events (via session.listMyEvents(), the
 * RLS-safe path) has a spendable balance, instead of only ever looking at
 * the bare account.
 */
class ScriptedLlm {
  readonly name = 'scripted';
  private steps: LlmCompletionResult[] = [];
  requests: LlmCompletionRequest[] = [];

  reset(): void {
    this.steps = [];
    this.requests = [];
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

describe('AI credit scope fallback — no active event yet (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let events: EventService;
  let billing: BillingService;
  let orchestrator: ConversationOrchestrator;
  const llm = new ScriptedLlm();

  let seq = 0;
  const makeUser = async (): Promise<Actor> => {
    const u = await prisma.user.create({
      data: { phone: `+256711${String(seq++).padStart(6, '0')}`, phoneVerified: true },
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
        BillingModule,
        AiModule,
      ],
    })
      .overrideProvider(LLM_PROVIDER)
      .useValue(llm)
      .compile();
    prisma = moduleRef.get(PrismaService);
    events = moduleRef.get(EventService);
    billing = moduleRef.get(BillingService);
    orchestrator = moduleRef.get(ConversationOrchestrator);
    await prisma.$connect();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    llm.reset();
    await prisma.$executeRawUnsafe(
      'TRUNCATE ai_credit_ledger, sms_credit_ledger, entitlement_grant, billing_account, message, conversation, invitation, usage_event, pending_confirmation, outbox, audit_event, allocation, fulfillment, pledge, budget_item, budget, person, event_member, event, "user", auth_otp_challenge RESTART IDENTITY CASCADE',
    );
  });

  it('does NOT block the first message when the account is empty but an owned event has credits', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Paid via event pack' });

    // Real-world shape: credits granted directly to the EVENT, never the
    // account (an event-scoped pack purchase, not an account subscription).
    await prisma.aiCreditLedger.create({
      data: {
        eventId: event.id,
        kind: 'GRANT',
        amount: 500,
        idempotencyKey: `test-grant:${event.id}`,
      },
    });

    // The account itself is real but genuinely holds 0 credits.
    const account = await billing.ensureBillingAccount(owner.userId);
    const accountBalance = await billing.aiBalance({ accountId: account.id });
    expect(accountBalance).toBe(0);

    llm.text('Hey! How can I help?');

    // No conversationId → brand-new conversation → no active event yet.
    const res = await orchestrator.converse(owner, 'hey');

    expect(res.reply).toContain('How can I help');
    // Spent from the event's own credits, not the empty account.
    const ledgerRows = await prisma.aiCreditLedger.findMany({
      where: { eventId: event.id },
      orderBy: { createdAt: 'asc' },
    });
    const spent = ledgerRows.filter((r) => r.kind !== 'GRANT');
    expect(spent.length).toBeGreaterThan(0);
  });

  it('still blocks honestly when NEITHER the account NOR any owned event has credits', async () => {
    const owner = await makeUser();
    await events.createEvent(owner, { name: 'Genuinely broke' });
    // No credits granted anywhere — account and event both start at 0.

    llm.text('should never be reached');

    await expect(orchestrator.converse(owner, 'hey')).rejects.toThrow(/0 AI credits remaining/);
  });

  it('prefers the account when it already has a balance (the common signup-trial case)', async () => {
    const owner = await makeUser();
    await events.createEvent(owner, { name: 'Fresh trial account' });
    const account = await billing.ensureBillingAccount(owner.userId);
    await billing.grantAiCredits({ accountId: account.id }, 50, `test-account-grant:${account.id}`);

    llm.text('Welcome!');
    const res = await orchestrator.converse(owner, 'hey');
    expect(res.reply).toContain('Welcome');
  });
});
