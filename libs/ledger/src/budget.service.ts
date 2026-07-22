import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ProvenanceSource } from '@prisma/client';
import { OperationContext, PermissionService, assertEventWritable } from '@akabbo/access';
import { TenantContext, TenantTx } from './tenant-context.service';
import { AuditWriter } from './audit.writer';
import { moneyToString } from './money';

export interface BudgetItemInput {
  name: string;
  targetValue: bigint;
  /** Provenance (§6). Defaults human_typed; extraction passes ai_from_document. */
  source?: ProvenanceSource;
  confidence?: number;
  sourceDocumentId?: string;
}

export interface BudgetItemView {
  id: string;
  name: string;
  targetValue: string;
  source: ProvenanceSource;
  sourceDocumentId: string | null;
  version: number;
}

/**
 * Budget planning (§11). A budget is a set of planned-spend line items. Items
 * carry PROVENANCE (§6): a line read off a photographed budget is
 * `ai_from_document` and links back to its source document, so every figure is
 * traceable. Edits are optimistically versioned (§42): two people editing the
 * budget at once cannot silently clobber each other.
 */
@Injectable()
export class BudgetService {
  constructor(
    private readonly tenant: TenantContext,
    private readonly permissions: PermissionService,
    private readonly audit: AuditWriter,
  ) {}

  /** The event's default budget, created on first use. */
  private async ensureBudget(tx: TenantTx, eventId: string): Promise<string> {
    const existing = await tx.budget.findFirst({ where: { eventId }, select: { id: true } });
    if (existing) return existing.id;
    const created = await tx.budget.create({ data: { eventId }, select: { id: true } });
    return created.id;
  }

  async addItem(ctx: OperationContext, input: BudgetItemInput): Promise<BudgetItemView> {
    this.permissions.assert(ctx.event.role, 'budget:write');
    assertEventWritable(ctx.event.status);

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const budgetId = await this.ensureBudget(tx, ctx.event.eventId);
      const source = input.source ?? ProvenanceSource.human_typed;
      const item = await tx.budgetItem.create({
        data: {
          eventId: ctx.event.eventId,
          budgetId,
          name: input.name,
          targetValue: input.targetValue,
          source,
          confidence: input.confidence ?? null,
          sourceDocumentId: input.sourceDocumentId ?? null,
          createdById: ctx.actor.userId,
        },
        select: {
          id: true,
          name: true,
          targetValue: true,
          source: true,
          sourceDocumentId: true,
          version: true,
        },
      });

      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'budget_item:create',
        resourceType: 'budget_item',
        resourceId: item.id,
        source,
        newValue: { name: item.name, targetValue: moneyToString(item.targetValue) },
      });

      return this.toView(item);
    });
  }

  /**
   * Update a line's name/value. `expectedVersion` guards against a concurrent
   * edit (§42): if the row changed since the caller read it, we reject rather
   * than silently overwrite. Corrections are audited old→new.
   */
  async updateItem(
    ctx: OperationContext,
    itemId: string,
    input: { name?: string; targetValue?: bigint; isPublic?: boolean; expectedVersion?: number },
  ): Promise<BudgetItemView> {
    this.permissions.assert(ctx.event.role, 'budget:write');
    assertEventWritable(ctx.event.status);

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const current = await tx.budgetItem.findFirst({
        where: { id: itemId },
        select: { id: true, name: true, targetValue: true, version: true },
      });
      if (!current) throw new NotFoundException('Budget item not found in this event');
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
        throw new ConflictException(
          'The budget changed since you loaded it — reload and try again',
        );
      }

      const updated = await tx.budgetItem.update({
        where: { id: itemId },
        data: {
          name: input.name ?? current.name,
          targetValue: input.targetValue ?? current.targetValue,
          // Per-line public visibility for PARTIALLY_PUBLIC budgets (Part 16).
          isPublic: input.isPublic,
          version: { increment: 1 },
        },
        select: {
          id: true,
          name: true,
          targetValue: true,
          source: true,
          sourceDocumentId: true,
          version: true,
        },
      });

      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'budget_item:update',
        resourceType: 'budget_item',
        resourceId: itemId,
        source: ProvenanceSource.manual_correction,
        oldValue: { name: current.name, targetValue: moneyToString(current.targetValue) },
        newValue: { name: updated.name, targetValue: moneyToString(updated.targetValue) },
      });

      return this.toView(updated);
    });
  }

  /**
   * Remove a budget line ("remove photography"). Refused if money has been
   * allocated to it — deleting an allocated line would orphan financial history;
   * the caller must reallocate first. Audited.
   */
  async removeItem(ctx: OperationContext, itemId: string): Promise<{ id: string; name: string }> {
    this.permissions.assert(ctx.event.role, 'budget:write');
    assertEventWritable(ctx.event.status);

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const item = await tx.budgetItem.findFirst({
        where: { id: itemId },
        select: { id: true, name: true, targetValue: true },
      });
      if (!item) throw new NotFoundException('Budget item not found in this event');

      const allocated = await tx.allocation.count({ where: { budgetItemId: itemId } });
      if (allocated > 0) {
        throw new ConflictException(
          `"${item.name}" has money allocated to it — reallocate before removing it`,
        );
      }

      await tx.budgetItem.delete({ where: { id: itemId } });
      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'budget_item:delete',
        resourceType: 'budget_item',
        resourceId: itemId,
        source: ProvenanceSource.manual_correction,
        oldValue: { name: item.name, targetValue: moneyToString(item.targetValue) },
      });
      return { id: item.id, name: item.name };
    });
  }

  async listItems(ctx: OperationContext): Promise<BudgetItemView[]> {
    this.permissions.assert(ctx.event.role, 'budget:read');
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const items = await tx.budgetItem.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          targetValue: true,
          source: true,
          sourceDocumentId: true,
          version: true,
        },
      });
      return items.map((i) => this.toView(i));
    });
  }

  private toView(i: {
    id: string;
    name: string;
    targetValue: bigint;
    source: ProvenanceSource;
    sourceDocumentId: string | null;
    version: number;
  }): BudgetItemView {
    return {
      id: i.id,
      name: i.name,
      targetValue: moneyToString(i.targetValue),
      source: i.source,
      sourceDocumentId: i.sourceDocumentId,
      version: i.version,
    };
  }
}
