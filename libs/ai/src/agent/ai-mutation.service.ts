import { Injectable } from '@nestjs/common';
import { EventRole, GroupKind } from '@prisma/client';
import {
  EntitlementService,
  OperationContext,
  PermissionService,
  assertEventWritable,
} from '@akabbo/access';
import { GroupService, MembershipService, TenantContext } from '@akabbo/ledger';
import { AnnouncementService } from '@akabbo/transparency';
import { SmsService } from '@akabbo/comms';
import { EntityResolver } from '../entity-resolver.service';
import { ConfirmationService } from '../confirmation.service';
import { StoredAction } from '../tool-executor.service';
import { parseAmountToMinorUnits } from '../amount';

/** Uniform outcome the agent turns into a tool result for the model. */
export interface StageResult {
  status: 'staged' | 'clarification' | 'error' | 'done';
  pendingId?: string;
  message: string;
  candidates?: string[];
  data?: unknown;
}

/** Group kinds the model may name; anything else falls back to OTHER. */
const GROUP_KINDS = new Set<string>(Object.values(GroupKind));

/**
 * Resolve-and-STAGE for the richer mutations the agent performs (budget edits,
 * corrections, merges — next-increment §2/§3/§4). Each resolves the entities a
 * name refers to (never guessing — ambiguity comes back as a clarification),
 * asserts the permission UP FRONT (so an injected instruction is denied before
 * anything is staged, §10), then parks a `pending_confirmation` the human
 * confirms. Execution (and its audit) is owned by the domain services via the
 * shared ToolExecutor — the AI only orchestrates.
 */
@Injectable()
export class AiMutationService {
  constructor(
    private readonly permissions: PermissionService,
    private readonly resolver: EntityResolver,
    private readonly confirmations: ConfirmationService,
    private readonly tenant: TenantContext,
    private readonly groups: GroupService,
    private readonly announcements: AnnouncementService,
    private readonly sms: SmsService,
    private readonly entitlements: EntitlementService,
    private readonly membership: MembershipService,
  ) {}

  // ── Side effects (next-increment §5/§6): announcements + reminders ───────────

  /**
   * Draft a public announcement (§6). The DRAFT is not yet public — a low-risk
   * write executed now; the organizer publishes it as a deliberate SIDE EFFECT.
   */
  async draftAnnouncement(ctx: OperationContext, body: string): Promise<StageResult> {
    if (!body.trim()) return clarify('What should the announcement say?');
    const a = await this.announcements.create(ctx, body.trim(), 'ai_from_chat');
    return {
      status: 'done',
      message: `Drafted the announcement — review it, then say "publish" to make it public.`,
      data: { announcementId: a.id, body: a.body },
    };
  }

  /** Update an existing committee member's role. Requires `member:manage`. */
  async updateMemberRole(
    ctx: OperationContext,
    targetUserIdOrPhone: string,
    roleInput: string,
  ): Promise<StageResult> {
    this.permissions.assert(ctx.event.role, 'member:manage');
    assertEventWritable(ctx.event.status);
    if (!targetUserIdOrPhone.trim()) return clarify('Whose role should I update?');

    const role = mapRole(roleInput);
    if (!role) {
      return clarify(
        'Which role should I assign? Choose one of: OWNER, CO_OWNER, COORDINATOR, FINANCE, or VIEWER.',
      );
    }

    const members = await this.membership.listMembers(ctx);
    const normalizedInput = targetUserIdOrPhone.replace(/\D/g, '');
    const target = members.find(
      (m) =>
        m.userId === targetUserIdOrPhone.trim() ||
        (normalizedInput && m.user.phone.replace(/\D/g, '').includes(normalizedInput)),
    );

    if (!target) {
      return clarify(
        `Could not find an active committee member matching "${targetUserIdOrPhone}".`,
      );
    }

    const updated = await this.membership.updateRole(ctx, target.userId, role);
    return {
      status: 'done',
      message: `Updated committee member's role to ${role}.`,
      data: updated,
    };
  }

  /** Publish a drafted announcement — the SIDE EFFECT that makes it public, with optional SMS broadcast. */
  async publishAnnouncement(
    ctx: OperationContext,
    announcementId: string,
    sendSms = false,
  ): Promise<StageResult> {
    if (!announcementId.trim()) return clarify('Which announcement should I publish?');
    const a = await this.announcements.publish(ctx, announcementId.trim());

    if (sendSms) {
      try {
        const smsResult = await this.sms.sendAnnouncement(ctx, a.body);
        return {
          status: 'done',
          message: `Published the announcement to the public event page and queued SMS broadcast to ${smsResult.queued} contributor(s)${smsResult.skipped > 0 ? ` (${smsResult.skipped} skipped due to SMS credit limit)` : ''}.`,
          data: { ...a, smsResult },
        };
      } catch (err) {
        const errStr = err instanceof Error ? err.message : String(err);
        return {
          status: 'done',
          message: `Published the announcement to the public event page. (SMS broadcast could not be sent: ${errStr})`,
          data: a,
        };
      }
    }

    return {
      status: 'done',
      message: 'Published the announcement to the public event page.',
      data: a,
    };
  }

  /**
   * Preview a reminder blast (recipients + affordability) and STAGE it for
   * confirmation — sending SMS is a SIDE EFFECT that spends credits (product spec
   * Part 24). The organizer confirms; the worker then sends, committing/refunding
   * each credit. Never sends without a human approving.
   */
  async prepareReminders(ctx: OperationContext, body: string): Promise<StageResult> {
    if (!body.trim()) return clarify('What should the reminder say?');
    const preview = await this.sms.previewReminders(ctx);
    if (preview.recipientCount === 0) {
      return { status: 'done', message: 'Everyone with a phone has paid — no one to remind.' };
    }
    if (preview.affordable === 0) {
      return clarify(
        `${preview.recipientCount} contributor(s) are outstanding, but you have 0 SMS credits. Top up to send reminders.`,
      );
    }
    const note =
      preview.affordable < preview.recipientCount
        ? ` (only ${preview.affordable} affordable with your ${preview.smsBalance} credits)`
        : '';
    return this.stage(
      ctx,
      { tool: 'send_sms_reminders', body: body.trim() },
      `Send a reminder to ${preview.recipientCount} outstanding contributor(s)${note}? This uses SMS credits.`,
    );
  }

  /**
   * Invite a COMMITTEE MEMBER (management access) — NOT a contributor. Resolves
   * the role from natural language (default COORDINATOR for "committee member"),
   * gates on `member:manage` (owner-tier), and STAGES the invitation. On confirm
   * it creates a share/join link the invitee uses with phone + OTP (§4/§36).
   */
  async inviteMember(
    ctx: OperationContext,
    name: string | undefined,
    role: string | undefined,
    phone: string | undefined,
  ): Promise<StageResult> {
    this.permissions.assert(ctx.event.role, 'member:manage');
    const who = name?.trim() || 'this person';

    // NEVER assume the role. If it isn't clearly stated, ask what the person
    // should be able to DO — in plain language, no technical terms.
    const resolvedRole = mapRole(role);
    if (resolvedRole === null) {
      return {
        status: 'clarification',
        message:
          `What should ${who} be able to do? Reply with one:\n` +
          `• Help run the event — add people, record payments, and send reminders\n` +
          `• Handle the money — record and correct payments only\n` +
          `• Co-organize — full control, including inviting others\n` +
          `• Just view progress — see the event but not change anything`,
      };
    }

    // Seat gate (metering §7): tell them up front if the plan is full.
    const seat = await this.entitlements.check({ eventId: ctx.event.eventId }, 'add_member');
    if (!seat.allowed) {
      return {
        status: 'clarification',
        message: seat.message ?? 'Your plan has no free team seats.',
      };
    }

    return this.stage(
      ctx,
      {
        tool: 'invite_member',
        role: resolvedRole,
        displayName: name?.trim() || undefined,
        phone: phone?.trim() || undefined,
      },
      `Invite ${who} so they can ${roleSummary(resolvedRole)}? ` +
        `I'll create a join link they open to enter their phone and verify a code.`,
    );
  }

  // ── Groups (low-risk; executed immediately, still gated + audited) ────────────

  async createGroup(ctx: OperationContext, name: string, kind?: string): Promise<StageResult> {
    if (!name.trim()) return clarify('What should the group be called?');
    const groupKind =
      kind && GROUP_KINDS.has(kind.toUpperCase())
        ? (kind.toUpperCase() as GroupKind)
        : GroupKind.OTHER;
    const group = await this.groups.createGroup(ctx, name.trim(), groupKind);
    return { status: 'done', message: `Created group "${group.name}".`, data: group };
  }

  async assignToGroup(
    ctx: OperationContext,
    personName: string,
    groupName: string,
  ): Promise<StageResult> {
    const person = await this.resolver.resolvePerson(ctx.event.eventId, personName);
    if (person.status === 'ambiguous') return ambiguous(person.candidates);
    if (person.status !== 'resolved') return clarify(`I don't know anyone called ${personName}.`);
    const group = await this.resolveGroup(ctx, groupName);
    if (group.status !== 'one') return group.result;
    await this.groups.assignPerson(ctx, person.personId, group.id);
    return {
      status: 'done',
      message: `Added ${person.displayName} to "${group.name}".`,
    };
  }

  private async resolveGroup(
    ctx: OperationContext,
    name: string,
  ): Promise<
    { status: 'one'; id: string; name: string } | { status: 'other'; result: StageResult }
  > {
    const rows = await this.tenant.runInEvent(
      ctx.event.eventId,
      (tx) =>
        tx.$queryRaw<{ id: string; name: string }[]>`
        SELECT id, name FROM contributor_group WHERE lower(name) = lower(${name.trim()})
      `,
    );
    if (rows.length === 1) return { status: 'one', id: rows[0].id, name: rows[0].name };
    if (rows.length === 0) {
      return { status: 'other', result: clarify(`There's no group called "${name}" yet.`) };
    }
    return {
      status: 'other',
      result: { status: 'clarification', message: `More than one group matches "${name}".` },
    };
  }

  // ── Budget ──────────────────────────────────────────────────────────────────

  async addBudgetItem(ctx: OperationContext, name: string, amount: string): Promise<StageResult> {
    this.permissions.assert(ctx.event.role, 'budget:write');
    const value = parseAmountToMinorUnits(amount);
    if (!name.trim() || value === null) return clarify('Which item, and what amount?');
    return this.stage(
      ctx,
      { tool: 'create_budget_item', name: name.trim(), targetValue: value.toString() },
      `Add budget item "${name.trim()}" at ${value.toString()}?`,
    );
  }

  async updateBudgetItem(
    ctx: OperationContext,
    name: string,
    amount: string,
  ): Promise<StageResult> {
    this.permissions.assert(ctx.event.role, 'budget:write');
    const value = parseAmountToMinorUnits(amount);
    if (value === null) return clarify('What should the new amount be?');
    const item = await this.resolveBudgetItem(ctx, name);
    if (item.status !== 'one') return item.result;
    return this.stage(
      ctx,
      {
        tool: 'update_budget_item',
        itemId: item.id,
        name: item.name,
        targetValue: value.toString(),
      },
      `Change "${item.name}" to ${value.toString()}?`,
    );
  }

  async removeBudgetItem(ctx: OperationContext, name: string): Promise<StageResult> {
    this.permissions.assert(ctx.event.role, 'budget:write');
    const item = await this.resolveBudgetItem(ctx, name);
    if (item.status !== 'one') return item.result;
    return this.stage(
      ctx,
      { tool: 'remove_budget_item', itemId: item.id, name: item.name },
      `Remove budget item "${item.name}"?`,
    );
  }

  // ── Corrections ──────────────────────────────────────────────────────────────

  async correctPledge(
    ctx: OperationContext,
    personName: string,
    amount: string,
  ): Promise<StageResult> {
    this.permissions.assert(ctx.event.role, 'fulfillment:correct');
    const value = parseAmountToMinorUnits(amount);
    if (value === null) return clarify('What is the corrected pledge amount?');
    const person = await this.resolver.resolvePerson(ctx.event.eventId, personName);
    if (person.status === 'ambiguous') return ambiguous(person.candidates);
    if (person.status !== 'resolved') return clarify(`I don't know anyone called ${personName}.`);
    const pledge = await this.resolver.resolvePledgeForPerson(ctx.event.eventId, person.personId);
    if (pledge.status !== 'resolved') {
      return clarify(`I can't find a single pledge for ${person.displayName} to correct.`);
    }
    return this.stage(
      ctx,
      {
        tool: 'correct_pledge',
        pledgeId: pledge.pledgeId,
        displayName: person.displayName,
        newValue: value.toString(),
      },
      `Correct ${person.displayName}'s pledge to ${value.toString()}?`,
    );
  }

  async correctPayment(
    ctx: OperationContext,
    personName: string,
    amount: string,
  ): Promise<StageResult> {
    this.permissions.assert(ctx.event.role, 'fulfillment:correct');
    const value = parseAmountToMinorUnits(amount);
    if (value === null) return clarify('What is the corrected payment amount?');
    const person = await this.resolver.resolvePerson(ctx.event.eventId, personName);
    if (person.status === 'ambiguous') return ambiguous(person.candidates);
    if (person.status !== 'resolved') return clarify(`I don't know anyone called ${personName}.`);

    const fulfillmentId = await this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT f.id FROM fulfillment f
        JOIN pledge pl ON f.pledge_id = pl.id
        WHERE pl.person_id = ${person.personId}::uuid AND pl.status <> 'CANCELLED'
        ORDER BY f.occurred_at DESC LIMIT 1
      `;
      return rows[0]?.id ?? null;
    });
    if (!fulfillmentId)
      return clarify(`I can't find a recorded payment from ${person.displayName}.`);

    return this.stage(
      ctx,
      {
        tool: 'correct_payment',
        fulfillmentId,
        displayName: person.displayName,
        newValue: value.toString(),
      },
      `Correct ${person.displayName}'s latest payment to ${value.toString()}?`,
    );
  }

  // ── Merge ────────────────────────────────────────────────────────────────────

  async mergePeople(
    ctx: OperationContext,
    sourceName: string,
    targetName: string,
  ): Promise<StageResult> {
    this.permissions.assert(ctx.event.role, 'person:merge');
    const source = await this.resolver.resolvePerson(ctx.event.eventId, sourceName);
    if (source.status === 'ambiguous') return ambiguous(source.candidates);
    if (source.status !== 'resolved') return clarify(`I don't know anyone called ${sourceName}.`);
    const target = await this.resolver.resolvePerson(ctx.event.eventId, targetName);
    if (target.status === 'ambiguous') return ambiguous(target.candidates);
    if (target.status !== 'resolved') return clarify(`I don't know anyone called ${targetName}.`);
    if (source.personId === target.personId) return clarify('Those are the same record already.');

    return this.stage(
      ctx,
      {
        tool: 'merge_people',
        sourceId: source.personId,
        targetId: target.personId,
        sourceName: source.displayName,
        targetName: target.displayName,
      },
      `Merge ${source.displayName} into ${target.displayName}? All their pledges and payments move across; this cannot be undone automatically.`,
    );
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private async stage(
    ctx: OperationContext,
    action: StoredAction,
    prompt: string,
  ): Promise<StageResult> {
    const pending = await this.confirmations.create(ctx, {
      intent: action.tool,
      action,
      confidence: null,
      prompt,
    });
    return { status: 'staged', pendingId: pending.id, message: prompt };
  }

  /** Case-insensitive budget-item lookup by name; asks when 0 or >1 match. */
  private async resolveBudgetItem(
    ctx: OperationContext,
    name: string,
  ): Promise<
    { status: 'one'; id: string; name: string } | { status: 'other'; result: StageResult }
  > {
    const rows = await this.tenant.runInEvent(
      ctx.event.eventId,
      (tx) =>
        tx.$queryRaw<{ id: string; name: string }[]>`
        SELECT id, name FROM budget_item WHERE lower(name) = lower(${name.trim()})
      `,
    );
    if (rows.length === 1) return { status: 'one', id: rows[0].id, name: rows[0].name };
    if (rows.length === 0) {
      return { status: 'other', result: clarify(`There's no budget item called "${name}".`) };
    }
    return {
      status: 'other',
      result: {
        status: 'clarification',
        message: `More than one budget item matches "${name}".`,
        candidates: rows.map((r) => r.name),
      },
    };
  }
}

function clarify(message: string): StageResult {
  return { status: 'clarification', message };
}

function ambiguous(candidates: { displayName: string }[]): StageResult {
  return {
    status: 'clarification',
    message: 'Which person do you mean?',
    candidates: candidates.map((c) => c.displayName),
  };
}

/**
 * Map an EXPLICIT capability phrase to a role — or `null` when it isn't clear,
 * so the agent ASKS rather than assumes (the organizer's explicit requirement).
 * Vague inputs ("committee", "a member", "") deliberately return null. We never
 * grant true OWNER via an invite; the strongest invitable role is CO_OWNER.
 */
function mapRole(role: string | undefined): EventRole | null {
  const r = (role ?? '').toLowerCase().trim();
  if (!r) return null;
  if (/(co-?owner|co-?organi|full (control|access)|everything|all access)/.test(r)) {
    return EventRole.CO_OWNER;
  }
  if (
    /(finance|treasurer|cashier|handle (the )?money|record (and )?correct|payments? only)/.test(r)
  ) {
    return EventRole.FINANCE;
  }
  if (/(view|read[- ]?only|observ|see (the )?progress|guest|just look|watch)/.test(r)) {
    return EventRole.VIEWER;
  }
  if (
    /(run|coordinat|organi[sz]e|manage the event|help run|day[- ]?to[- ]?day|add people)/.test(r)
  ) {
    return EventRole.COORDINATOR;
  }
  return null; // "committee", "member", unclear → ask, don't assume
}

/** Plain-language description of what a role can do (no technical terms). */
function roleSummary(role: EventRole): string {
  switch (role) {
    case EventRole.CO_OWNER:
      return 'co-organize the event with full control, including inviting others';
    case EventRole.FINANCE:
      return 'record and correct payments';
    case EventRole.VIEWER:
      return 'view the event progress but not make changes';
    case EventRole.COORDINATOR:
    default:
      return 'help run the event — add people, record payments, and send reminders';
  }
}
