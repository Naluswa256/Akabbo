import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfirmationStatus, PledgeType, Prisma, ProvenanceSource } from '@prisma/client';
import { OperationContext } from '@akabbo/access';
import { TenantContext } from '@akabbo/ledger';
import { formatAmount } from './amount';
import { ExecutionResult, StoredAction, ToolExecutor } from './tool-executor.service';

export interface PendingView {
  id: string;
  intent: string;
  prompt: string;
  confidence: number | null;
  status: ConfirmationStatus;
}

export interface UpdatePendingInput {
  displayName?: string;
  amount?: string;
  type?: PledgeType;
  description?: string;
}

/**
 * Intents a pending confirmation can be edited for, and which fields on the
 * underlying StoredAction each accepts — deliberately a narrow allowlist
 * (contribution/pledge-shaped writes only) rather than a generic JSON-patch:
 * every other intent (budget items, merges, reminders, invites, ...) either
 * doesn't have these fields or has referential ones (ids) that a partial
 * edit can't safely resolve without redoing entity resolution.
 */
const EDITABLE_INTENTS = new Set([
  'record_pledge',
  'record_pledge_with_payment',
  'record_direct_contribution',
  'record_payment',
]);

/**
 * The pending_confirmation flow (blueprint §6, invariant §3.8). Low-confidence
 * or document-derived writes land here as NON-canonical proposals. A human
 * confirm executes the stored action through the same domain services (both
 * gates re-checked) and stamps that human into the provenance chain; reject
 * discards it. This is also the prompt-injection safety valve: nothing an
 * untrusted source implies becomes canonical without a human approving it.
 */
@Injectable()
export class ConfirmationService {
  constructor(
    private readonly tenant: TenantContext,
    private readonly executor: ToolExecutor,
  ) {}

  async create(
    ctx: OperationContext,
    input: { intent: string; action: StoredAction; confidence: number | null; prompt: string },
  ): Promise<PendingView> {
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const row = await tx.pendingConfirmation.create({
        data: {
          eventId: ctx.event.eventId,
          intent: input.intent,
          payload: input.action as unknown as Prisma.InputJsonValue,
          confidence: input.confidence,
          prompt: input.prompt,
          source: ProvenanceSource.ai_from_chat,
          createdById: ctx.actor.userId,
        },
        select: { id: true, intent: true, prompt: true, confidence: true, status: true },
      });
      return row;
    });
  }

  async listPending(ctx: OperationContext): Promise<PendingView[]> {
    return this.tenant.runInEvent(ctx.event.eventId, (tx) =>
      tx.pendingConfirmation.findMany({
        where: { status: ConfirmationStatus.PENDING },
        orderBy: { createdAt: 'asc' },
        select: { id: true, intent: true, prompt: true, confidence: true, status: true },
      }),
    );
  }

  /**
   * Edit a still-pending proposal's amount/description/etc before confirming
   * it — e.g. correcting a figure a document scan misread. Only the fields
   * present in `edits` change; the rest of the stored action (person/pledge
   * resolution, budget-item link) is untouched. Re-validates the merged
   * result the same way a fresh capture would (a non-empty amount, a real
   * enum value) rather than trusting the edit blindly, since this payload is
   * executed VERBATIM on confirm. No permission gate here, matching
   * confirm/reject above — the domain services re-check both gates when the
   * (possibly edited) action is actually executed.
   */
  async update(ctx: OperationContext, id: string, edits: UpdatePendingInput): Promise<PendingView> {
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const row = await tx.pendingConfirmation.findFirst({ where: { id } });
      if (!row) throw new NotFoundException('Pending confirmation not found');
      if (row.status !== ConfirmationStatus.PENDING) {
        throw new BadRequestException(`Already ${row.status.toLowerCase()}`);
      }
      if (!EDITABLE_INTENTS.has(row.intent)) {
        throw new BadRequestException(
          `Editing is not supported for "${row.intent}" — cancel and re-capture instead.`,
        );
      }

      const action = { ...(row.payload as unknown as StoredAction) } as Record<string, unknown>;
      if (edits.displayName !== undefined) action.displayName = edits.displayName;
      // record_payment has no `type`/`description` on its StoredAction shape
      // (it discharges an existing pledge, whose type is already fixed) —
      // silently ignored there rather than erroring, per the DTO's contract.
      if (edits.amount !== undefined) action.amount = edits.amount;
      if (edits.type !== undefined && row.intent !== 'record_payment') action.type = edits.type;
      if (edits.description !== undefined && row.intent !== 'record_payment') {
        action.description = edits.description || undefined;
      }
      if (typeof action.amount === 'string' && !/^\d+$/.test(action.amount)) {
        throw new BadRequestException('amount must be an integer (minor units)');
      }

      const prompt = renderPendingPrompt(row.intent, action);
      const updated = await tx.pendingConfirmation.update({
        where: { id },
        data: { payload: action as unknown as Prisma.InputJsonValue, prompt },
        select: { id: true, intent: true, prompt: true, confidence: true, status: true },
      });
      return updated;
    });
  }

  /**
   * Confirm a pending proposal: execute it (domain services re-check both
   * gates) and mark it resolved with the confirming human recorded. Provenance
   * stays ai_from_chat, but the human is now in the chain via resolvedById +
   * the audit actor.
   */
  async confirm(ctx: OperationContext, id: string): Promise<ExecutionResult> {
    const pending = await this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const row = await tx.pendingConfirmation.findFirst({ where: { id } });
      if (!row) throw new NotFoundException('Pending confirmation not found');
      if (row.status !== ConfirmationStatus.PENDING) {
        throw new BadRequestException(`Already ${row.status.toLowerCase()}`);
      }
      // Mark resolved up-front (single-use); the execution runs in its own txn.
      await tx.pendingConfirmation.update({
        where: { id },
        data: {
          status: ConfirmationStatus.CONFIRMED,
          resolvedById: ctx.actor.userId,
          resolvedAt: new Date(),
        },
      });
      return { action: row.payload as unknown as StoredAction, source: row.source };
    });

    // The confirming human is the actor of record; provenance carries the
    // pending row's own source (ai_from_chat OR ai_from_document), so an
    // extracted figure stays traceable to its document after promotion.
    return this.executor.run(ctx, pending.action, pending.source);
  }

  async reject(
    ctx: OperationContext,
    id: string,
  ): Promise<{ id: string; status: ConfirmationStatus }> {
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const row = await tx.pendingConfirmation.findFirst({ where: { id } });
      if (!row) throw new NotFoundException('Pending confirmation not found');
      if (row.status !== ConfirmationStatus.PENDING) {
        throw new BadRequestException(`Already ${row.status.toLowerCase()}`);
      }
      const updated = await tx.pendingConfirmation.update({
        where: { id },
        data: {
          status: ConfirmationStatus.REJECTED,
          resolvedById: ctx.actor.userId,
          resolvedAt: new Date(),
        },
        select: { id: true, status: true },
      });
      return updated;
    });
  }
}

/**
 * Re-render a review prompt after an edit. Deliberately a single canonical
 * phrasing per intent rather than reproducing every nuance the original
 * staging call sites use (e.g. "Add X as a contributor" vs "Record X's
 * pledge" depending on whether the person already existed) — the wording
 * doesn't need to match exactly, just accurately describe what confirming
 * will do with the now-edited figures.
 */
function renderPendingPrompt(intent: string, action: Record<string, unknown>): string {
  const name = typeof action.displayName === 'string' ? action.displayName : 'this contributor';
  const amount = typeof action.amount === 'string' ? formatAmount(action.amount) : '0';
  const description =
    typeof action.description === 'string' && action.description ? ` (${action.description})` : '';
  switch (intent) {
    case 'record_pledge':
      return `Record ${name}'s pledge of ${amount}${description}?`;
    case 'record_pledge_with_payment': {
      const receivedNow =
        typeof action.receivedNow === 'string' ? formatAmount(action.receivedNow) : '0';
      return `Record ${name}'s pledge of ${amount}${description}, with ${receivedNow} already received?`;
    }
    case 'record_direct_contribution':
      return `Record ${name}'s contribution of ${amount}${description}?`;
    case 'record_payment':
      return `Record ${name}'s payment of ${amount}?`;
    default:
      return `Record ${name}'s ${amount}${description}?`;
  }
}
