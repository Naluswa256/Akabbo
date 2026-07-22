import { Test, TestingModule } from '@nestjs/testing';
import { PledgeType } from '@prisma/client';
import { AppConfigModule } from '@akabbo/config';
import { PrismaModule, PrismaService } from '@akabbo/prisma';
import { AccessModule, Actor, OperationContext } from '@akabbo/access';
import { IdentityModule } from '@akabbo/identity';
import {
  EventService,
  FulfillmentService,
  GroupService,
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
import { AiModule, AssistantService } from '@akabbo/ai';

/**
 * AI-increment Phase 3 DoD (next-increment §9): contributor groups / family
 * sides, rich in-kind item descriptions, and explicit fulfillment currency —
 * all additive, existing records unaffected.
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

describe('AI operating layer — Phase 3 groups + in-kind + currency (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let events: EventService;
  let membership: MembershipService;
  let people: PersonService;
  let pledges: PledgeService;
  let fulfillments: FulfillmentService;
  let groups: GroupService;
  let tenant: TenantContext;
  let assistant: AssistantService;
  const llm = new ScriptedLlm();

  let seq = 0;
  const makeUser = async (): Promise<Actor> => {
    const u = await prisma.user.create({
      data: { phone: `+256712${String(seq++).padStart(6, '0')}`, phoneVerified: true },
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
    groups = moduleRef.get(GroupService);
    tenant = moduleRef.get(TenantContext);
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

  it('creates a group, assigns people via chat, and rolls up group contributions (§9.1/9.2)', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Wedding' });
    const ctx = await ctxFor(owner, event.id);
    // Two contributors who have each received money.
    const john = await people.createPerson(ctx, { displayName: 'John' });
    const jp = await pledges.createPledge(ctx, { personId: john.id, committedValue: 500_000n });
    await fulfillments.recordFulfillment(ctx, { pledgeId: jp.id, value: 500_000n });
    const annet = await people.createPerson(ctx, { displayName: 'Annet' });
    const ap = await pledges.createPledge(ctx, { personId: annet.id, committedValue: 300_000n });
    await fulfillments.recordFulfillment(ctx, { pledgeId: ap.id, value: 200_000n });

    llm.tool('create_group', { name: "Bride's family", kind: 'FAMILY_SIDE' });
    llm.text("Created the group Bride's family.");
    await assistant.chat(ctx, "Create a group for the bride's family");

    llm.tool('assign_to_group', { personName: 'John', groupName: "Bride's family" });
    llm.text('Added John to the group.');
    await assistant.chat(ctx, "John is from the bride's family");

    llm.tool('assign_to_group', { personName: 'Annet', groupName: "Bride's family" });
    llm.text('Added Annet to the group.');
    await assistant.chat(ctx, "Annet too");

    const summary = await groups.groupContributions(ctx);
    expect(summary).toHaveLength(1);
    expect(summary[0].name).toBe("Bride's family");
    expect(summary[0].memberCount).toBe(2);
    expect(summary[0].committed).toBe('800000');
    expect(summary[0].received).toBe('700000');
    expect(summary[0].outstanding).toBe('100000');
  });

  it('records an in-kind pledge with a description, no invented money value (§9.3)', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Kwanjula' });
    const ctx = await ctxFor(owner, event.id);
    const peter = await people.createPerson(ctx, { displayName: 'Peter' });

    // "Peter is bringing 100 white plastic chairs" — an ITEM pledge, 0 money.
    await pledges.createPledge(ctx, {
      personId: peter.id,
      committedValue: 0n,
      type: PledgeType.ITEM,
      description: 'white plastic chairs',
      quantity: 100,
      unit: 'chairs',
    });

    const row = await tenant.runInEvent(event.id, (tx) =>
      tx.pledge.findFirstOrThrow({
        where: { personId: peter.id },
        select: { type: true, description: true, quantity: true, unit: true, committedValue: true, estimatedValue: true },
      }),
    );
    expect(row.type).toBe(PledgeType.ITEM);
    expect(row.description).toBe('white plastic chairs');
    expect(row.quantity).toBe(100);
    expect(row.unit).toBe('chairs');
    expect(row.committedValue).toBe(0n);
    expect(row.estimatedValue).toBeNull(); // never invents a value for goods
  });

  it('records a payment in an explicit non-UGX currency (§9.4)', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Diaspora' });
    const ctx = await ctxFor(owner, event.id);
    const sarah = await people.createPerson(ctx, { displayName: 'Sarah' });
    const sp = await pledges.createPledge(ctx, { personId: sarah.id, committedValue: 500n });
    await fulfillments.recordFulfillment(ctx, { pledgeId: sp.id, value: 500n, currency: 'USD' });

    const row = await tenant.runInEvent(event.id, (tx) =>
      tx.fulfillment.findFirstOrThrow({
        where: { pledgeId: sp.id },
        select: { currency: true, value: true },
      }),
    );
    expect(row.currency).toBe('USD');
    expect(row.value).toBe(500n);
  });
});
