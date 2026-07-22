import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfirmationStatus, Prisma, ProvenanceSource } from '@prisma/client';
import { OperationContext } from '@akabbo/access';
import { TenantContext } from '@akabbo/ledger';
import { ExecutionResult, StoredAction, ToolExecutor } from './tool-executor.service';

export interface PendingView {
  id: string;
  intent: string;
  prompt: string;
  confidence: number | null;
  status: ConfirmationStatus;
}

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
