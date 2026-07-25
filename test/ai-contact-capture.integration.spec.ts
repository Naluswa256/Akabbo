import { Test, TestingModule } from '@nestjs/testing';
import { AppConfigModule } from '@akabbo/config';
import { PrismaModule, PrismaService } from '@akabbo/prisma';
import { AccessModule, Actor, OperationContext } from '@akabbo/access';
import { IdentityModule } from '@akabbo/identity';
import { EventService, LedgerModule, MembershipService, PersonService } from '@akabbo/ledger';
import {
  LLM_PROVIDER,
  LlmCompletionRequest,
  LlmCompletionResult,
  ProvidersModule,
} from '@akabbo/providers';
import { AiModule, AssistantService, ConfirmationService } from '@akabbo/ai';
import { BillingModule, BillingService } from '@akabbo/billing';

/**
 * Regression test: a contributor added via chat had no way to ever get a
 * phone number persisted — `add_person` only ever accepted `displayName`,
 * and there was no tool to attach one afterward. The AI would even claim a
 * number was "noted" with no mechanism that could actually save it. Without
 * a phone on file, that contributor is silently excluded from every SMS
 * reminder/announcement (confirmed live: a real campaign resolved to 0
 * recipients because every contributor had `phone: null`).
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
    this.steps.push({
      toolCalls: [],
      text,
      usage: { inputTokens: 50, outputTokens: 10, model: 'scripted' },
    });
  }
}

describe('AI contact capture — phone numbers actually persist (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let events: EventService;
  let membership: MembershipService;
  let people: PersonService;
  let billing: BillingService;
  let assistant: AssistantService;
  let confirmations: ConfirmationService;
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
        BillingModule,
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
    billing = moduleRef.get(BillingService);
    assistant = moduleRef.get(AssistantService);
    confirmations = moduleRef.get(ConfirmationService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE ai_credit_ledger, message, conversation, payment_instruction, event_announcement, invitation, usage_event, pending_confirmation, outbox, audit_event, allocation, fulfillment, pledge, budget_item, budget, person, event_member, event, "user", auth_otp_challenge RESTART IDENTITY CASCADE',
    );
  });

  it('captures the phone number when adding a new contributor in the same message', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'E' });
    const ctx = await ctxFor(owner, event.id);
    await billing.grantAiCredits({ eventId: event.id }, 10, `test:${event.id}`);

    llm.tool('add_person', { displayName: 'Namayanja Prossy', phone: '0701578058' });
    llm.text('Staged: add Namayanja Prossy (0701578058) as a contributor?');
    const res = await assistant.chat(ctx, 'namayanja prossy 0701578058 has pledged for 30k');
    expect(res.staged).toHaveLength(1);

    await confirmations.confirm(ctx, res.staged[0]);

    const [person] = await people.listPeople(ctx);
    expect(person.displayName).toBe('Namayanja Prossy');
    expect(person.phone).toBe('0701578058');
  });

  it('attaches a phone number to an existing contributor via update_contact', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'E' });
    const ctx = await ctxFor(owner, event.id);
    await billing.grantAiCredits({ eventId: event.id }, 10, `test:${event.id}`);

    const jesse = await people.createPerson(ctx, { displayName: 'Jesse' });
    expect(jesse.phone).toBeNull();

    llm.tool('update_contact', { personName: 'Jesse', phone: '0741397184' });
    llm.text('Saved.');
    // update_contact is low-risk (doesn't move money or send anything by
    // itself) and executes immediately, like assign_to_group — nothing to
    // confirm, unlike financial writes.
    const res = await assistant.chat(ctx, "jesse's contact is 0741397184, make sure to save it");
    expect(res.staged).toHaveLength(0);

    const [updated] = await people.listPeople(ctx);
    expect(updated.phone).toBe('0741397184');
  });
});
