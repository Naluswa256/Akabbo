import { Injectable, NotFoundException } from '@nestjs/common';
import { PledgeStatus, PledgeType, Prisma } from '@prisma/client';
import { OperationContext, PermissionService } from '@akabbo/access';
import { PrismaService } from '@akabbo/prisma';
import { TenantContext } from './tenant-context.service';
import { outstanding } from './pledge-status';
import { moneyToString } from './money';

/**
 * Percentage of target received, rounded to one decimal. Null when no target is
 * set — we never invent a denominator.
 */
function percentCovered(received: bigint, target: bigint | null): number | null {
  if (target === null || target <= 0n) return null;
  return Math.round((Number(received) / Number(target)) * 1000) / 10;
}

export interface PledgeOutstanding {
  pledgeId: string;
  committedValue: string;
  totalFulfilled: string;
  outstanding: string;
  status: PledgeStatus;
}

export interface EventTotals {
  totalCommitted: string;
  totalFulfilled: string;
  totalOutstanding: string;
  pledgeCount: number;
}

export interface TopContributor {
  personId: string;
  displayName: string;
  committed: string;
  received: string;
  outstanding: string;
}

export interface LinkedPledge {
  personName: string;
  type: PledgeType;
  /** In-kind detail ("5 kg of meat") — null for CASH. */
  description: string | null;
  committedValue: string;
  status: PledgeStatus;
}

export type BudgetItemFunders =
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: string[] }
  | {
      status: 'resolved';
      itemName: string;
      target: string;
      covered: string;
      /** Money already allocated (from Fulfillment via Allocation). */
      funders: { displayName: string; value: string; occurredAt: string }[];
      /** Pledges earmarked for this item (Pledge.targetBudgetItemId) —
       *  promises/items, regardless of whether money has moved yet. Distinct
       *  from `funders`: a pledge can be linked here long before (or without
       *  ever) becoming an allocated fulfillment. */
      linkedPledges: LinkedPledge[];
    };

/** The full "how are we doing?" picture (§32, §40). Amounts — gated. */
export interface EventReport {
  target: string | null;
  percentCovered: number | null;
  totalCommitted: string;
  totalReceived: string;
  totalOutstanding: string;
  peopleCount: number;
  contributorCount: number;
  outstandingContributorCount: number;
  budgetTotal: string;
  budgetAllocated: string;
  budgetUnfunded: string;
  biggestGap: { budgetItemId: string; name: string; gap: string } | null;
  topContributors: TopContributor[];
}

/**
 * The REDACTED view (§12): a VIEWER sees "72% funded" and nothing else — no
 * amounts, no contributor list.
 */
export interface FundingSummary {
  percentCovered: number | null;
  hasTarget: boolean;
}

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId: string;
  source: string;
  oldValue: unknown;
  newValue: unknown;
  actorUserId: string | null;
  createdAt: string;
}

/**
 * Read-side of the ledger. Numeric answers come from SQL, computed here — never
 * from an LLM (§3.8). All reads run under the event's RLS scope.
 */
@Injectable()
export class LedgerQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
    private readonly permissions: PermissionService,
  ) {}

  async getPledgeOutstanding(ctx: OperationContext, pledgeId: string): Promise<PledgeOutstanding> {
    this.permissions.assert(ctx.event.role, 'ledger:read_amounts');
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const pledge = await tx.pledge.findFirst({
        where: { id: pledgeId },
        select: { id: true, committedValue: true, status: true },
      });
      if (!pledge) throw new NotFoundException('Pledge not found in this event');

      const agg = await tx.fulfillment.aggregate({
        where: { pledgeId },
        _sum: { value: true },
      });
      const totalFulfilled = agg._sum.value ?? 0n;

      return {
        pledgeId: pledge.id,
        committedValue: moneyToString(pledge.committedValue),
        totalFulfilled: moneyToString(totalFulfilled),
        outstanding: moneyToString(outstanding(pledge.committedValue, totalFulfilled)),
        status: pledge.status,
      };
    });
  }

  /** Event-wide totals, excluding cancelled pledges from the commitment base. */
  async getEventTotals(ctx: OperationContext): Promise<EventTotals> {
    this.permissions.assert(ctx.event.role, 'ledger:read_amounts');
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const committedAgg = await tx.pledge.aggregate({
        where: { status: { not: PledgeStatus.CANCELLED } },
        _sum: { committedValue: true },
        _count: true,
      });
      const fulfilledAgg = await tx.fulfillment.aggregate({ _sum: { value: true } });

      const totalCommitted = committedAgg._sum.committedValue ?? 0n;
      const totalFulfilled = fulfilledAgg._sum.value ?? 0n;

      return {
        totalCommitted: moneyToString(totalCommitted),
        totalFulfilled: moneyToString(totalFulfilled),
        totalOutstanding: moneyToString(outstanding(totalCommitted, totalFulfilled)),
        pledgeCount: committedAgg._count,
      };
    });
  }

  /**
   * "How are we doing?" (§32, §40) — the whole picture in one grounded read:
   * target, % covered, received/outstanding, contributor counts, budget gaps,
   * and the largest balances. Every number comes from SQL; the LLM only phrases
   * it (§3.8). Requires `ledger:read_amounts`.
   */
  async getEventReport(ctx: OperationContext, topN = 5): Promise<EventReport> {
    this.permissions.assert(ctx.event.role, 'ledger:read_amounts');

    const target = await this.prisma.event
      .findUnique({ where: { id: ctx.event.eventId }, select: { targetAmount: true } })
      .then((e) => e?.targetAmount ?? null);

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const committedAgg = await tx.pledge.aggregate({
        where: { status: { not: PledgeStatus.CANCELLED } },
        _sum: { committedValue: true },
      });
      const receivedAgg = await tx.fulfillment.aggregate({ _sum: { value: true } });
      const totalCommitted = committedAgg._sum.committedValue ?? 0n;
      const totalReceived = receivedAgg._sum.value ?? 0n;

      const peopleCount = await tx.person.count();

      // Per-person rollup. Subqueries (not joins) so multiple fulfillments do
      // not multiply the committed sum. Cast to bigint so Prisma returns BigInt.
      const rows = await tx.$queryRaw<
        { id: string; display_name: string; committed: bigint; received: bigint }[]
      >`
        SELECT p.id,
               p.display_name,
               COALESCE((SELECT SUM(pl.committed_value) FROM pledge pl
                          WHERE pl.person_id = p.id AND pl.status <> 'CANCELLED'), 0)::bigint AS committed,
               COALESCE((SELECT SUM(f.value) FROM fulfillment f
                          JOIN pledge pl2 ON f.pledge_id = pl2.id
                          WHERE pl2.person_id = p.id AND pl2.status <> 'CANCELLED'), 0)::bigint AS received
        FROM person p
      `;

      const withBalances = rows.map((r) => ({
        personId: r.id,
        displayName: r.display_name,
        committed: r.committed,
        received: r.received,
        outstandingValue: outstanding(r.committed, r.received),
      }));

      const contributorCount = withBalances.filter((r) => r.committed > 0n).length;
      const outstandingContributorCount = withBalances.filter(
        (r) => r.outstandingValue > 0n,
      ).length;

      const topContributors = [...withBalances]
        .sort((a, b) => (b.received === a.received ? 0 : b.received > a.received ? 1 : -1))
        .slice(0, topN)
        .map((r) => ({
          personId: r.personId,
          displayName: r.displayName,
          committed: moneyToString(r.committed),
          received: moneyToString(r.received),
          outstanding: moneyToString(r.outstandingValue),
        }));

      // Budget rollup (populated once budget items/allocations exist).
      const budgetAgg = await tx.budgetItem.aggregate({ _sum: { targetValue: true } });
      const allocAgg = await tx.allocation.aggregate({ _sum: { value: true } });
      const budgetTotal = budgetAgg._sum.targetValue ?? 0n;
      const budgetAllocated = allocAgg._sum.value ?? 0n;

      const gaps = await tx.$queryRaw<{ id: string; name: string; gap: bigint }[]>`
        SELECT bi.id,
               bi.name,
               (bi.target_value - COALESCE((SELECT SUM(a.value) FROM allocation a
                                             WHERE a.budget_item_id = bi.id), 0))::bigint AS gap
        FROM budget_item bi
        ORDER BY gap DESC
        LIMIT 1
      `;
      const biggestGap =
        gaps.length > 0 && gaps[0].gap > 0n
          ? { budgetItemId: gaps[0].id, name: gaps[0].name, gap: moneyToString(gaps[0].gap) }
          : null;

      return {
        target: target === null ? null : moneyToString(target),
        percentCovered: percentCovered(totalReceived, target),
        totalCommitted: moneyToString(totalCommitted),
        totalReceived: moneyToString(totalReceived),
        totalOutstanding: moneyToString(outstanding(totalCommitted, totalReceived)),
        peopleCount,
        contributorCount,
        outstandingContributorCount,
        budgetTotal: moneyToString(budgetTotal),
        budgetAllocated: moneyToString(budgetAllocated),
        budgetUnfunded: moneyToString(outstanding(budgetTotal, budgetAllocated)),
        biggestGap,
        topContributors,
      };
    });
  }

  /**
   * Who funded a specific budget line and how much each person put toward it.
   * Allocations only ever store a total on the budget item itself — this is
   * the explicit join (allocation → fulfillment → pledge → person) needed to
   * answer "who funded catering", which nothing else surfaces.
   */
  async getBudgetItemFunders(ctx: OperationContext, itemName: string): Promise<BudgetItemFunders> {
    this.permissions.assert(ctx.event.role, 'budget:read');
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const items = await tx.$queryRaw<{ id: string; name: string; target: bigint }[]>`
        SELECT id, name, target_value::bigint AS target
        FROM budget_item
        WHERE lower(name) = lower(${itemName.trim()})
      `;
      if (items.length === 0) return { status: 'not_found' };
      if (items.length > 1) {
        return { status: 'ambiguous', candidates: items.map((i) => i.name) };
      }
      return this.fundersForItem(tx, items[0]);
    });
  }

  /** Same as {@link getBudgetItemFunders} but resolved by id — the REST path,
   *  where the frontend already has the item id from the list view and
   *  name-based ambiguity doesn't apply. */
  async getBudgetItemFundersById(
    ctx: OperationContext,
    itemId: string,
  ): Promise<BudgetItemFunders> {
    this.permissions.assert(ctx.event.role, 'budget:read');
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const item = await tx.budgetItem.findFirst({
        where: { id: itemId },
        select: { id: true, name: true, targetValue: true },
      });
      if (!item) return { status: 'not_found' };
      return this.fundersForItem(tx, { id: item.id, name: item.name, target: item.targetValue });
    });
  }

  private async fundersForItem(
    tx: Prisma.TransactionClient,
    item: { id: string; name: string; target: bigint },
  ): Promise<BudgetItemFunders> {
    const funders = await tx.$queryRaw<
      { display_name: string; value: bigint; occurred_at: Date }[]
    >`
      SELECT p.display_name, a.value::bigint AS value, f.occurred_at
      FROM allocation a
      JOIN fulfillment f ON a.fulfillment_id = f.id
      JOIN pledge pl ON f.pledge_id = pl.id
      JOIN person p ON pl.person_id = p.id
      WHERE a.budget_item_id = ${item.id}::uuid
      ORDER BY f.occurred_at ASC
    `;
    const covered = funders.reduce((sum, f) => sum + f.value, 0n);

    const linked = await tx.pledge.findMany({
      where: { targetBudgetItemId: item.id },
      select: {
        type: true,
        description: true,
        committedValue: true,
        status: true,
        person: { select: { displayName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return {
      status: 'resolved',
      itemName: item.name,
      target: moneyToString(item.target),
      covered: moneyToString(covered),
      funders: funders.map((f) => ({
        displayName: f.display_name,
        value: moneyToString(f.value),
        occurredAt: f.occurred_at.toISOString(),
      })),
      linkedPledges: linked.map((p) => ({
        personName: p.person.displayName,
        type: p.type,
        description: p.description,
        committedValue: moneyToString(p.committedValue),
        status: p.status,
      })),
    };
  }

  /**
   * The redacted funding view (§12) — the ONLY financial signal a VIEWER gets:
   * a percentage, never an amount. Requires `ledger:read_funding`.
   */
  async getFundingSummary(ctx: OperationContext): Promise<FundingSummary> {
    this.permissions.assert(ctx.event.role, 'ledger:read_funding');

    const target = await this.prisma.event
      .findUnique({ where: { id: ctx.event.eventId }, select: { targetAmount: true } })
      .then((e) => e?.targetAmount ?? null);

    const received = await this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const agg = await tx.fulfillment.aggregate({ _sum: { value: true } });
      return agg._sum.value ?? 0n;
    });

    return { percentCovered: percentCovered(received, target), hasTarget: target !== null };
  }

  /** Full audit trail for a resource (who/what/when/source/old→new). */
  async getAuditTrail(
    ctx: OperationContext,
    resourceType: string,
    resourceId: string,
  ): Promise<AuditEntry[]> {
    this.permissions.assert(ctx.event.role, 'ledger:read_amounts');
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const rows = await tx.auditEvent.findMany({
        where: { resourceType, resourceId },
        orderBy: { createdAt: 'asc' },
        select: {
          action: true,
          resourceType: true,
          resourceId: true,
          source: true,
          oldValue: true,
          newValue: true,
          actorUserId: true,
          createdAt: true,
        },
      });
      return rows.map((r) => ({
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        source: r.source,
        oldValue: r.oldValue,
        newValue: r.newValue,
        actorUserId: r.actorUserId,
        createdAt: r.createdAt.toISOString(),
      }));
    });
  }
}
