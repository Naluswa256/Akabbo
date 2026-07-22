import { Injectable, NotFoundException } from '@nestjs/common';
import { OperationContext, PermissionService, assertEventWritable } from '@akabbo/access';
import { TenantContext } from './tenant-context.service';
import { AuditWriter } from './audit.writer';
import { moneyToString } from './money';

export interface AllocationView {
  id: string;
  fulfillmentId: string;
  budgetItemId: string;
  value: string;
}

/**
 * Allocation — earmarks a received contribution against a budget line (§13:
 * "Budget allocation: Catering"). This is what makes `budgetUnfunded` and
 * `biggestGap` in the report meaningful: allocated money reduces a line's gap.
 * Optional by design — an event can run without allocating anything.
 */
@Injectable()
export class AllocationService {
  constructor(
    private readonly tenant: TenantContext,
    private readonly permissions: PermissionService,
    private readonly audit: AuditWriter,
  ) {}

  async allocate(
    ctx: OperationContext,
    fulfillmentId: string,
    budgetItemId: string,
    value: bigint,
  ): Promise<AllocationView> {
    this.permissions.assert(ctx.event.role, 'budget:write');
    assertEventWritable(ctx.event.status);

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const fulfillment = await tx.fulfillment.findFirst({
        where: { id: fulfillmentId },
        select: { id: true },
      });
      if (!fulfillment) throw new NotFoundException('Fulfillment not found in this event');
      const item = await tx.budgetItem.findFirst({
        where: { id: budgetItemId },
        select: { id: true },
      });
      if (!item) throw new NotFoundException('Budget item not found in this event');

      const allocation = await tx.allocation.create({
        data: { eventId: ctx.event.eventId, fulfillmentId, budgetItemId, value },
        select: { id: true, fulfillmentId: true, budgetItemId: true, value: true },
      });

      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'allocation:create',
        resourceType: 'allocation',
        resourceId: allocation.id,
        newValue: { fulfillmentId, budgetItemId, value: moneyToString(value) },
      });

      return {
        id: allocation.id,
        fulfillmentId: allocation.fulfillmentId,
        budgetItemId: allocation.budgetItemId,
        value: moneyToString(allocation.value),
      };
    });
  }
}
