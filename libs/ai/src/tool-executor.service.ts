import { Injectable } from '@nestjs/common';
import { EventRole, PledgeType, ProvenanceSource } from '@prisma/client';
import { OperationContext } from '@akabbo/access';
import { AppConfigService } from '@akabbo/config';
import {
  BudgetService,
  FulfillmentService,
  InvitationService,
  LedgerQueryService,
  PersonService,
  PledgeService,
} from '@akabbo/ledger';
import { SmsService } from '@akabbo/comms';

export interface ExecutionResult {
  /** Human-facing confirmation/answer, grounded in DB numbers (not the LLM). */
  message: string;
  data: unknown;
}

/**
 * A fully-RESOLVED, JSON-serialisable action (ids resolved, amount as a digit
 * string). This is what gets stored in a pending_confirmation payload and what
 * `run` executes — so the direct path and the confirm path share one executor.
 */
export type StoredAction =
  | { tool: 'add_person'; displayName: string }
  | {
      tool: 'record_pledge';
      personId?: string;
      displayName: string;
      amount: string;
      type?: PledgeType;
      phone?: string;
    }
  | { tool: 'record_payment'; pledgeId: string; displayName: string; amount: string }
  /** A gift with no prior pledge (§15) — creates the commitment and discharges it. */
  | {
      tool: 'record_direct_contribution';
      personId?: string;
      displayName: string;
      amount: string;
      phone?: string;
    }
  /** A budget line proposed by document extraction, promoted on confirmation. */
  | { tool: 'create_budget_item'; name: string; targetValue: string; sourceDocumentId?: string }
  | { tool: 'update_budget_item'; itemId: string; name: string; targetValue: string }
  | { tool: 'remove_budget_item'; itemId: string; name: string }
  | { tool: 'correct_pledge'; pledgeId: string; displayName: string; newValue: string }
  | { tool: 'correct_payment'; fulfillmentId: string; displayName: string; newValue: string }
  | {
      tool: 'merge_people';
      sourceId: string;
      targetId: string;
      sourceName: string;
      targetName: string;
    }
  /** A reminder blast the organizer approved — sent (credit-metered) on confirm. */
  | { tool: 'send_sms_reminders'; body: string }
  /** Invite a COMMITTEE MEMBER (management access) — creates a share/join link. */
  | { tool: 'invite_member'; role: EventRole; displayName?: string; phone?: string }
  | { tool: 'get_outstanding_pledge'; pledgeId: string; displayName: string }
  | { tool: 'get_summary' };

/**
 * Executes a RESOLVED tool intent by calling the exact same Phase-1 domain
 * services the typed API calls — the AI has no privileged path (CLAUDE.md §4).
 * Both gates (permission + entitlement) run INSIDE those services, so a tool
 * call the model proposes is still only a *request*: it cannot bypass authority
 * (§10, the prompt-injection safety property).
 *
 * Numeric answers come from SQL here; the model only phrases them (§3.8).
 */
@Injectable()
export class ToolExecutor {
  constructor(
    private readonly people: PersonService,
    private readonly pledges: PledgeService,
    private readonly fulfillments: FulfillmentService,
    private readonly budget: BudgetService,
    private readonly queries: LedgerQueryService,
    private readonly sms: SmsService,
    private readonly invitations: InvitationService,
    private readonly config: AppConfigService,
  ) {}

  /** Dispatch a resolved action to the right typed call. */
  run(
    ctx: OperationContext,
    action: StoredAction,
    source: ProvenanceSource,
  ): Promise<ExecutionResult> {
    switch (action.tool) {
      case 'add_person':
        return this.addPerson(ctx, action.displayName, source);
      case 'record_pledge':
        return this.recordPledge(
          ctx,
          action.personId,
          action.displayName,
          BigInt(action.amount),
          source,
          action.type,
          action.phone,
        );
      case 'record_payment':
        return this.recordPayment(
          ctx,
          action.pledgeId,
          action.displayName,
          BigInt(action.amount),
          source,
        );
      case 'record_direct_contribution':
        return this.recordDirectContribution(
          ctx,
          action.personId,
          action.displayName,
          BigInt(action.amount),
          source,
          action.phone,
        );
      case 'create_budget_item':
        return this.createBudgetItem(
          ctx,
          action.name,
          BigInt(action.targetValue),
          source,
          action.sourceDocumentId,
        );
      case 'update_budget_item':
        return this.updateBudgetItem(ctx, action.itemId, action.name, BigInt(action.targetValue));
      case 'remove_budget_item':
        return this.removeBudgetItem(ctx, action.itemId);
      case 'correct_pledge':
        return this.correctPledge(
          ctx,
          action.pledgeId,
          action.displayName,
          BigInt(action.newValue),
        );
      case 'correct_payment':
        return this.correctPayment(
          ctx,
          action.fulfillmentId,
          action.displayName,
          BigInt(action.newValue),
        );
      case 'merge_people':
        return this.mergePeople(ctx, action);
      case 'send_sms_reminders':
        return this.sendReminders(ctx, action.body);
      case 'invite_member':
        return this.inviteMember(ctx, action);
      case 'get_outstanding_pledge':
        return this.getOutstandingForPledge(ctx, action.pledgeId, action.displayName);
      case 'get_summary':
        return this.getSummary(ctx);
    }
  }

  async updateBudgetItem(
    ctx: OperationContext,
    itemId: string,
    name: string,
    targetValue: bigint,
  ): Promise<ExecutionResult> {
    const item = await this.budget.updateItem(ctx, itemId, { name, targetValue });
    return { message: `Updated budget item "${item.name}" to ${item.targetValue}.`, data: item };
  }

  async removeBudgetItem(ctx: OperationContext, itemId: string): Promise<ExecutionResult> {
    const removed = await this.budget.removeItem(ctx, itemId);
    return { message: `Removed budget item "${removed.name}".`, data: removed };
  }

  async correctPledge(
    ctx: OperationContext,
    pledgeId: string,
    displayName: string,
    newValue: bigint,
  ): Promise<ExecutionResult> {
    const pledge = await this.pledges.correctCommittedValue(ctx, pledgeId, newValue);
    return {
      message: `Corrected ${displayName}'s pledge to ${pledge.committedValue}.`,
      data: pledge,
    };
  }

  async correctPayment(
    ctx: OperationContext,
    fulfillmentId: string,
    displayName: string,
    newValue: bigint,
  ): Promise<ExecutionResult> {
    const f = await this.fulfillments.correctValue(ctx, fulfillmentId, newValue);
    return {
      message: `Corrected ${displayName}'s payment to ${f.value} (outstanding ${f.outstanding}).`,
      data: f,
    };
  }

  async mergePeople(
    ctx: OperationContext,
    action: { sourceId: string; targetId: string; sourceName: string; targetName: string },
  ): Promise<ExecutionResult> {
    const result = await this.people.mergePeople(ctx, action.sourceId, action.targetId);
    return {
      message: `Merged ${action.sourceName} into ${action.targetName} (moved ${result.movedPledges} pledge(s)).`,
      data: result,
    };
  }

  async sendReminders(ctx: OperationContext, body: string): Promise<ExecutionResult> {
    const result = await this.sms.sendReminders(ctx, body);
    const skipped = result.skipped > 0 ? ` (${result.skipped} skipped — out of credits)` : '';
    return {
      message: `Queued reminders to ${result.queued} contributor(s)${skipped}.`,
      data: result,
    };
  }

  /**
   * Invite a COMMITTEE MEMBER (blueprint §4/§36): create a share-link invitation
   * with a role. The token is the capability — the invitee opens the link,
   * enters their phone, verifies OTP, and JOINS as an event member. Distinct
   * from `add_person` (a contributor). Returns the join link for the organizer
   * to share; the frontend builds the URL when no PUBLIC_APP_URL is configured.
   */
  async inviteMember(
    ctx: OperationContext,
    action: { role: EventRole; displayName?: string; phone?: string },
  ): Promise<ExecutionResult> {
    const invitation = await this.invitations.createInvitation(ctx, {
      role: action.role,
      invitedPhone: action.phone,
    });
    const invitePath = `/join/${invitation.token}`;
    const base = this.config.get('PUBLIC_APP_URL');
    const inviteUrl = base ? `${base.replace(/\/$/, '')}${invitePath}` : null;
    const who = action.displayName ?? 'the member';
    return {
      message:
        `Invitation created for ${who} as ${invitation.role}. Share this link — they join by ` +
        `entering their phone and verifying an OTP:\n${inviteUrl ?? invitePath}`,
      data: {
        token: invitation.token,
        role: invitation.role,
        invitePath,
        inviteUrl,
        expiresAt: invitation.expiresAt,
        displayName: action.displayName ?? null,
      },
    };
  }

  async addPerson(
    ctx: OperationContext,
    displayName: string,
    source: ProvenanceSource,
  ): Promise<ExecutionResult> {
    const person = await this.people.createPerson(ctx, { displayName, source });
    return { message: `Added ${person.displayName}.`, data: person };
  }

  async recordPledge(
    ctx: OperationContext,
    personId: string | undefined,
    displayName: string,
    amount: bigint,
    source: ProvenanceSource,
    type?: PledgeType,
    phone?: string,
  ): Promise<ExecutionResult> {
    let targetPersonId = personId;
    if (!targetPersonId) {
      const person = await this.people.createPerson(ctx, { displayName, phone, source });
      targetPersonId = person.id;
    }
    const pledge = await this.pledges.createPledge(ctx, {
      personId: targetPersonId,
      committedValue: amount,
      type,
      source,
    });
    return {
      message: `Recorded ${displayName}'s pledge of ${amount.toString()}.`,
      data: pledge,
    };
  }

  async recordPayment(
    ctx: OperationContext,
    pledgeId: string,
    displayName: string,
    amount: bigint,
    source: ProvenanceSource,
  ): Promise<ExecutionResult> {
    const f = await this.fulfillments.recordFulfillment(ctx, { pledgeId, value: amount, source });
    return {
      message:
        `Recorded ${displayName}'s payment of ${amount.toString()}. ` +
        `Outstanding on that pledge: ${f.outstanding}.`,
      data: f,
    };
  }

  /**
   * "Peter gave me 100k cash" where Peter has no pledge (§15). The organizer
   * should never be told to "record a pledge first" for money that already
   * arrived — this records the commitment and its discharge together.
   */
  async recordDirectContribution(
    ctx: OperationContext,
    personId: string | undefined,
    displayName: string,
    amount: bigint,
    source: ProvenanceSource,
    phone?: string,
  ): Promise<ExecutionResult> {
    const f = await this.fulfillments.recordDirectContribution(ctx, {
      personId,
      displayName,
      phone,
      value: amount,
      source,
    });
    return {
      message: `Recorded ${displayName}'s contribution of ${amount.toString()}.`,
      data: f,
    };
  }

  /**
   * Promote an extracted budget line to canonical (§6.1). Provenance is
   * `ai_from_document` and links back to the source document, and — because
   * this runs on human CONFIRM — a human is stamped into the chain.
   */
  async createBudgetItem(
    ctx: OperationContext,
    name: string,
    targetValue: bigint,
    source: ProvenanceSource,
    sourceDocumentId?: string,
  ): Promise<ExecutionResult> {
    const item = await this.budget.addItem(ctx, {
      name,
      targetValue,
      source,
      sourceDocumentId,
    });
    return { message: `Added budget item “${item.name}” (${item.targetValue}).`, data: item };
  }

  async getOutstandingForPledge(
    ctx: OperationContext,
    pledgeId: string,
    displayName: string,
  ): Promise<ExecutionResult> {
    const o = await this.queries.getPledgeOutstanding(ctx, pledgeId);
    return { message: `${displayName} still owes ${o.outstanding}.`, data: o };
  }

  /**
   * "How are we doing?" (§40). Every number is computed in SQL and merely
   * phrased here — the model never calculates.
   */
  async getSummary(ctx: OperationContext): Promise<ExecutionResult> {
    const r = await this.queries.getEventReport(ctx);

    const parts: string[] = [];
    if (r.percentCovered !== null) {
      parts.push(`Your event is ${r.percentCovered}% covered (target ${r.target}).`);
    }
    parts.push(
      `Received ${r.totalReceived}, outstanding pledges ${r.totalOutstanding}, ` +
        `committed ${r.totalCommitted}.`,
    );
    if (r.budgetTotal !== '0') {
      parts.push(`Unfunded budget ${r.budgetUnfunded}.`);
    }
    parts.push(
      `${r.contributorCount} contributors, ${r.outstandingContributorCount} with outstanding balances.`,
    );
    if (r.biggestGap) {
      parts.push(`Your biggest funding gap is ${r.biggestGap.name}.`);
    }

    return { message: parts.join(' '), data: r };
  }
}
