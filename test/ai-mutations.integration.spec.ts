import { Test, TestingModule } from '@nestjs/testing';
import { AppConfigModule } from '@akabbo/config';
import { PrismaModule, PrismaService } from '@akabbo/prisma';
import { AccessModule, Actor, OperationContext } from '@akabbo/access';
import { IdentityModule } from '@akabbo/identity';
import {
  BudgetService,
  EventService,
  FulfillmentService,
  LedgerModule,
  MembershipService,
  PersonService,
  PledgeService,
  TenantContext,
} from '@akabbo/ledger';
import {
  LLM_PROVIDER,
  LlmCompletionRequest,
  LlmCompletionResult,
  ProvidersModule,
} from '@akabbo/providers';
import { AiModule, AssistantService, ConfirmationService } from '@akabbo/ai';

/**
 * AI-increment Phase 2 DoD (next-increment §2/§3/§4): budget edits, corrections
 * and merge — all STAGED for confirmation, all preserving audit history, all
 * executed by the domain (not the AI). Confirming runs the real mutation.
 */
class ScriptedLlm {
  readonly name = 'scripted';
  private steps: LlmCompletionResult[] = [];
  complete(_req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const next = this.steps.shift();
    if (!next) throw new Error('ScriptedLlm out of steps');
    return Promise.resolve(next);
  }
  tool(name: string, args: Record<string, unknown> = {}): void {
    this.steps.push({
      toolCalls: [{ id: `c${this.steps.length}`, name, arguments: args }],
      usage: { inputTokens: 50, outputTokens: 10, model: 'scripted' },
    });
  }
  text(text: string): void {
    this.steps.push({ toolCalls: [], text, usage: { inputTokens: 50, outputTokens: 10, model: 'scripted' } });
  }
}

describe('AI operating layer — Phase 2 mutations (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let events: EventService;
  let membership: MembershipService;
  let people: PersonService;
  let pledges: PledgeService;
  let fulfillments: FulfillmentService;
  let budget: BudgetService;
  let tenant: TenantContext;
  let assistant: AssistantService;
  let confirmations: ConfirmationService;
  const llm = new ScriptedLlm();

  let seq = 0;
  const makeUser = async (): Promise<Actor> => {
    const u = await prisma.user.create({
      data: { phone: `+256711${String(seq++).padStart(6, '0')}`, phoneVerified: true },
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
    events = moduleRef.get(EventService);
    membership = moduleRef.get(MembershipService);
    people = moduleRef.get(PersonService);
    pledges = moduleRef.get(PledgeService);
    fulfillments = moduleRef.get(FulfillmentService);
    budget = moduleRef.get(BudgetService);
    tenant = moduleRef.get(TenantContext);
    assistant = moduleRef.get(AssistantService);
    confirmations = moduleRef.get(ConfirmationService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE message, conversation, payment_instruction, event_announcement, invitation, usage_event, pending_confirmation, outbox, audit_event, allocation, fulfillment, pledge, budget_item, budget, person, event_member, event, "user", auth_otp_challenge RESTART IDENTITY CASCADE',
    );
  });

  it('corrects a payment: staged, then confirming updates the canonical value + audits (§3)', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'E', targetAmount: 10_000_000n });
    const ctx = await ctxFor(owner, event.id);
    const john = await people.createPerson(ctx, { displayName: 'John' });
    const jp = await pledges.createPledge(ctx, { personId: john.id, committedValue: 5_000_000n });
    await fulfillments.recordFulfillment(ctx, { pledgeId: jp.id, value: 500_000n });

    llm.tool('correct_payment', { personName: 'John', amount: '300k' });
    llm.text("I've staged a correction of John's payment to UGX 300,000 — confirm it?");
    const res = await assistant.chat(ctx, 'Actually John paid 300k, not 500k');

    expect(res.staged).toHaveLength(1);
    // Not yet applied — still 500k until confirmed.
    const before = await confirmations.listPending(ctx);
    expect(before[0].intent).toBe('correct_payment');

    await confirmations.confirm(ctx, res.staged[0]);

    const { value, audits } = await tenant.runInEvent(event.id, async (tx) => ({
      value: await tx.fulfillment.findMany({ select: { value: true } }),
      audits: await tx.auditEvent.count({ where: { action: 'fulfillment:correct' } }),
    }));
    expect(value[0].value).toBe(300_000n);
    // The original figure survives in the audit trail (append-only).
    expect(audits).toBe(1);
  });

  it('adds then updates then removes a budget item, all staged and confirmed (§2)', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Budget' });
    const ctx = await ctxFor(owner, event.id);

    llm.tool('add_budget_item', { name: 'Catering', amount: '5m' });
    llm.text('Staged: add Catering at 5,000,000.');
    const add = await assistant.chat(ctx, 'Add catering at 5M');
    await confirmations.confirm(ctx, add.staged[0]);
    let items = await budget.listItems(ctx);
    expect(items).toHaveLength(1);
    expect(items[0].targetValue).toBe('5000000');

    llm.tool('update_budget_item', { name: 'Catering', amount: '6m' });
    llm.text('Staged: change Catering to 6,000,000.');
    const upd = await assistant.chat(ctx, 'Catering is now 6M');
    await confirmations.confirm(ctx, upd.staged[0]);
    items = await budget.listItems(ctx);
    expect(items[0].targetValue).toBe('6000000');

    llm.tool('remove_budget_item', { name: 'Catering' });
    llm.text('Staged: remove Catering.');
    const rem = await assistant.chat(ctx, 'Remove catering');
    await confirmations.confirm(ctx, rem.staged[0]);
    items = await budget.listItems(ctx);
    expect(items).toHaveLength(0);
  });

  it('merges two duplicate people, moving all pledges to the canonical one (§4)', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Dupes' });
    const ctx = await ctxFor(owner, event.id);
    const kato = await people.createPerson(ctx, { displayName: 'John Kato' });
    const k = await people.createPerson(ctx, { displayName: 'John K' });
    await pledges.createPledge(ctx, { personId: kato.id, committedValue: 500_000n });
    await pledges.createPledge(ctx, { personId: k.id, committedValue: 200_000n });

    llm.tool('merge_people', { sourceName: 'John K', targetName: 'John Kato' });
    llm.text('Staged: merge John K into John Kato.');
    const res = await assistant.chat(ctx, 'John Kato and John K are the same person');
    await confirmations.confirm(ctx, res.staged[0]);

    // Source gone; target holds both pledges (history preserved).
    const remaining = await people.listPeople(ctx);
    expect(remaining.map((p) => p.displayName).sort()).toEqual(['John Kato']);
    const pledgeCount = await tenant.runInEvent(event.id, (tx) =>
      tx.pledge.count({ where: { personId: kato.id } }),
    );
    expect(pledgeCount).toBe(2);
  });

  it('refuses to correct a payment for an unknown person (never guesses)', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'X' });
    const ctx = await ctxFor(owner, event.id);

    llm.tool('correct_payment', { personName: 'Ghost', amount: '100k' });
    llm.text("I don't have anyone called Ghost.");
    const res = await assistant.chat(ctx, "Fix Ghost's payment to 100k");
    expect(res.staged).toHaveLength(0);
    expect(await confirmations.listPending(ctx)).toHaveLength(0);
  });
});
