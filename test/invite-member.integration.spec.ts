import { Test, TestingModule } from '@nestjs/testing';
import { EventRole } from '@prisma/client';
import { AppConfigModule } from '@akabbo/config';
import { PrismaModule, PrismaService } from '@akabbo/prisma';
import { AccessModule, Actor, OperationContext } from '@akabbo/access';
import { IdentityModule } from '@akabbo/identity';
import {
  EventService,
  InvitationService,
  LedgerModule,
  MembershipService,
} from '@akabbo/ledger';
import {
  LLM_PROVIDER,
  LlmCompletionRequest,
  LlmCompletionResult,
  ProvidersModule,
} from '@akabbo/providers';
import {
  AiModule,
  AiMutationService,
  AiQueryService,
  AssistantService,
  ConfirmationService,
} from '@akabbo/ai';

/**
 * "Invite a committee member" (blueprint §4/§36) — the CORRECT, seat-aware flow:
 *  • it INVITES (share link + role), never adds a contributor;
 *  • it NEVER assumes the role — an unspecified role is asked in plain language;
 *  • it respects the plan's team-seat allowance (metering §7);
 *  • confirming returns a join link; the invitee joins via phone + OTP.
 * Plus: "give me the public link" returns the real shareable link.
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

describe('AI invite committee member + public link (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let events: EventService;
  let membership: MembershipService;
  let invitations: InvitationService;
  let assistant: AssistantService;
  let confirmations: ConfirmationService;
  let mutations: AiMutationService;
  let queries: AiQueryService;
  const llm = new ScriptedLlm();

  let seq = 0;
  const makeUser = async (): Promise<Actor> => {
    const u = await prisma.user.create({
      data: { phone: `+256718${String(seq++).padStart(6, '0')}`, phoneVerified: true },
      select: { id: true },
    });
    return { userId: u.id, phoneVerified: true };
  };
  const ctxFor = async (a: Actor, e: string): Promise<OperationContext> => ({
    actor: a,
    event: await membership.requireContext(a, e),
  });
  /** Give the event a paid plan (seats) by inserting an active grant. */
  const grantPlan = async (eventId: string, code: string): Promise<void> => {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code }, select: { id: true } });
    await prisma.entitlementGrant.create({ data: { eventId, planId: plan.id, status: 'ACTIVE' } });
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
    membership = moduleRef.get(MembershipService);
    invitations = moduleRef.get(InvitationService);
    assistant = moduleRef.get(AssistantService);
    confirmations = moduleRef.get(ConfirmationService);
    mutations = moduleRef.get(AiMutationService);
    queries = moduleRef.get(AiQueryService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE sms_message, sms_campaign, invoice, sms_credit_ledger, entitlement_grant, billing_account, person_group, contributor_group, message, conversation, payment_instruction, event_announcement, invitation, usage_event, pending_confirmation, outbox, audit_event, allocation, fulfillment, pledge, budget_item, budget, person, event_member, event, "user", auth_otp_challenge RESTART IDENTITY CASCADE',
    );
  });

  it('invites with an explicit role → confirm returns a join link → invitee joins as a member', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Marvin & Ashley Introduction' });
    await grantPlan(event.id, 'STARTER'); // 2 seats
    const ctx = await ctxFor(owner, event.id);

    llm.tool('invite_member', { name: 'Kawuma Joash', role: 'help run the event' });
    llm.text('Staged an invitation for Kawuma Joash — confirm to get the link.');
    const res = await assistant.chat(ctx, 'invite Kawuma Joash to help run the event');

    expect(res.staged).toHaveLength(1);
    expect((await confirmations.listPending(ctx))[0].intent).toBe('invite_member');
    // It is NOT add_person — no contributor was created.
    const persons = await prisma.$queryRawUnsafe<{ c: number }[]>(`SELECT count(*)::int AS c FROM person`);
    expect(persons[0].c).toBe(0);

    const confirmed = await confirmations.confirm(ctx, res.staged[0]);
    const data = confirmed.data as { token: string; role: EventRole; invitePath: string };
    expect(data.role).toBe(EventRole.COORDINATOR);
    expect(data.invitePath).toBe(`/join/${data.token}`);

    const invite = await invitations.getByToken(data.token);
    expect(invite.eventName).toBe('Marvin & Ashley Introduction');
    expect(invite.valid).toBe(true);

    const kawuma = await makeUser();
    await invitations.acceptInvitation(kawuma, data.token);
    expect((await membership.requireContext(kawuma, event.id)).role).toBe(EventRole.COORDINATOR);
  });

  it('NEVER assumes the role — an unspecified role is asked in plain language', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Ask' });
    await grantPlan(event.id, 'STARTER');
    const ctx = await ctxFor(owner, event.id);

    // "invite a member" with no capability stated → clarify, don't stage.
    const r = await mutations.inviteMember(ctx, 'Joash', undefined, undefined);
    expect(r.status).toBe('clarification');
    expect(r.message).toContain('Help run the event');
    expect(r.message).toContain('Just view progress');
    // Vague words like "committee" also don't assume a role.
    const r2 = await mutations.inviteMember(ctx, 'Joash', 'committee', undefined);
    expect(r2.status).toBe('clarification');
    // No pending action was staged.
    expect(await confirmations.listPending(ctx)).toHaveLength(0);
  });

  it('respects the plan seat limit — FREE (1 seat) cannot invite; the message says upgrade', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Solo' }); // FREE fallback → 1 seat (owner)
    const ctx = await ctxFor(owner, event.id);

    const r = await mutations.inviteMember(ctx, 'Second Person', 'help run the event', undefined);
    expect(r.status).toBe('clarification');
    expect(r.message.toLowerCase()).toContain('seat');
    expect(r.message.toLowerCase()).toContain('upgrade');

    // The domain gate is enforced too — creating an invitation directly is blocked.
    await expect(
      invitations.createInvitation(ctx, { role: EventRole.COORDINATOR }),
    ).rejects.toThrow();
  });

  it('maps explicit access words to roles: treasurer → FINANCE, co-owner → CO_OWNER', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Roles' });
    await grantPlan(event.id, 'PREMIUM'); // unlimited seats
    const ctx = await ctxFor(owner, event.id);

    const t = await mutations.inviteMember(ctx, 'Treasurer', 'handle the money', undefined);
    expect(t.status).toBe('staged');
    const c1 = await confirmations.confirm(ctx, t.pendingId!);
    expect((c1.data as { role: EventRole }).role).toBe(EventRole.FINANCE);

    const co = await mutations.inviteMember(ctx, 'Sarah', 'co-organize', undefined);
    const c2 = await confirmations.confirm(ctx, co.pendingId!);
    expect((c2.data as { role: EventRole }).role).toBe(EventRole.CO_OWNER);
  });

  it('"give me the public link" returns the real shareable link', async () => {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Public' });
    const ctx = await ctxFor(owner, event.id);
    const link = await queries.getPublicLink(ctx);
    expect(link.isPublic).toBe(true);
    expect(link.slug).toBeTruthy();
    expect(link.publicPath).toBe(`/e/${link.slug}`);
    expect(link.tokenRequired).toBe(false);
  });
});
