import { Injectable } from '@nestjs/common';
import { OperationContext, PermissionService } from '@akabbo/access';
import { PrismaService } from '@akabbo/prisma';
import { moneyToString } from './money';
import { outstanding } from './pledge-status';

export type ReportType = 'CONTRIBUTORS' | 'PLEDGES' | 'OUTSTANDING' | 'BUDGET' | 'PAYMENTS';
export type ContributorStatus = 'all' | 'unpaid' | 'partial' | 'complete' | 'outstanding';
export type PresentationTier = 'INLINE_CHAT' | 'MEDIUM_PREVIEW' | 'LARGE_REPORT';

export interface ReportFilters {
  reportType: ReportType;
  /** Unified status vocabulary — same as AiQueryService.listContributors */
  status?: ContributorStatus;
  /** Raw group name string — resolved against ContributorGroup before querying */
  groupName?: string;
  minAmount?: number;
  maxAmount?: number;
  searchTerm?: string;
  sortField?: 'amount' | 'name';
  sortDirection?: 'asc' | 'desc';
  /** How many rows to return. Defaults to MAX_LIMIT — i.e. everything, up to
   *  the safety cap — so a single call always has the full answer with no
   *  "call once to learn the total, call again for everyone" round-trip.
   *  Pass a smaller value only if a deliberately short list is wanted. */
  limit?: number;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = MAX_LIMIT;

export interface ReportPreviewRow {
  name: string;
  group?: string;
  amount: string;
  outstanding?: string;
  status: string;
  /** In-kind pledges (ITEM/SERVICE — "5 kg of meat", "100 cartons of water"),
   *  one entry per pledge. Not reflected in `amount`, which is cash only. */
  inKind?: string[];
}

export interface ReportRef {
  reportType: ReportType;
  /** Human-readable label for the chip button, e.g. "35 contributors — outstanding only" */
  label: string;
  /** Stateless URL with filters encoded as query params, e.g. /events/:id/report/contributors?status=outstanding */
  filterUrl: string;
  totalRecords: number;
  totalAmount: string;
  currency: 'UGX';
}

export interface ReportResult {
  tier: PresentationTier;
  reportRef: ReportRef;
  /** Up to `input.limit` rows (default 5) for inline chat — pass a higher
   *  limit for "show me everyone"/comprehensive requests instead of treating
   *  this as a fixed teaser. */
  preview: ReportPreviewRow[];
  /** Set when groupName matched 0 or 2+ groups — model should ask which group */
  ambiguousGroup?: { term: string; candidates: { id: string; name: string }[] };
}

/**
 * Stateless report query engine. No rows are ever written to the database —
 * filters are encoded in the URL that the frontend opens. This means:
 *  - No staleness: totals and rows come from the same live query
 *  - No expiry sweep needed
 *  - No cross-tenant leak: eventId in the path always gates access
 */
@Injectable()
export class ReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * Resolves a group name string against the event's ContributorGroups.
   * Returns the matching group id, or an ambiguity result for the model to surface.
   */
  private async resolveGroupName(
    eventId: string,
    groupName: string,
  ): Promise<
    | { ok: true; groupId: string; groupNameResolved: string }
    | { ok: false; candidates: { id: string; name: string }[] }
  > {
    const matches = await this.prisma.contributorGroup.findMany({
      where: {
        eventId,
        name: { contains: groupName, mode: 'insensitive' },
      },
      select: { id: true, name: true },
    });

    if (matches.length === 1) {
      return { ok: true, groupId: matches[0].id, groupNameResolved: matches[0].name };
    }
    // 0 or 2+ matches → ambiguous
    return { ok: false, candidates: matches };
  }

  /**
   * Primary AI reporting entry point. Runs a live Prisma query, applies tiering,
   * and returns a stateless `ReportRef` with filters baked into the URL.
   */
  async generateReport(
    ctx: OperationContext,
    input: ReportFilters,
  ): Promise<ReportResult> {
    this.permissions.assert(ctx.event.role, 'event:read');
    const eventId = ctx.event.eventId;

    // ── Group name resolution ────────────────────────────────────────────────
    let resolvedGroupId: string | undefined;
    let resolvedGroupName: string | undefined;
    let ambiguousGroup: ReportResult['ambiguousGroup'];

    if (input.groupName) {
      const resolution = await this.resolveGroupName(eventId, input.groupName);
      if (!resolution.ok) {
        ambiguousGroup = { term: input.groupName, candidates: resolution.candidates };
        // Still proceed but without group filter so model can surface the ambiguity
      } else {
        resolvedGroupId = resolution.groupId;
        resolvedGroupName = resolution.groupNameResolved;
      }
    }

    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    // ── Query by report type ──────────────────────────────────────────────────
    let totalRecords = 0;
    let totalAmountBigInt = 0n;
    const preview: ReportPreviewRow[] = [];

    if (
      input.reportType === 'CONTRIBUTORS' ||
      input.reportType === 'OUTSTANDING' ||
      input.reportType === 'PLEDGES'
    ) {
      const rows = await this.queryContributors(eventId, input, resolvedGroupId);

      totalRecords = rows.length;
      totalAmountBigInt = rows.reduce((acc, r) => acc + r._received, 0n);

      for (const r of rows.slice(0, limit)) {
        const owed = outstanding(r._committed, r._received);
        preview.push({
          name: r.displayName,
          group: r.groupName,
          amount: moneyToString(r._received),
          outstanding: owed > 0n ? moneyToString(owed) : undefined,
          status: r._committed === 0n ? 'no_pledge' : r._received >= r._committed ? 'complete' : r._received > 0n ? 'partial' : 'unpaid',
          inKind: r._inKind.length > 0 ? r._inKind : undefined,
        });
      }
    } else if (input.reportType === 'BUDGET') {
      const items = await this.prisma.budgetItem.findMany({
        where: { eventId },
        select: {
          id: true,
          name: true,
          targetValue: true,
          allocations: { select: { value: true } },
        },
      });

      totalRecords = items.length;
      totalAmountBigInt = items.reduce((acc: bigint, i) => acc + i.targetValue, 0n);

      for (const i of items.slice(0, limit)) {
        const allocated = i.allocations.reduce((acc: bigint, a) => acc + a.value, 0n);
        preview.push({
          name: i.name,
          amount: moneyToString(i.targetValue),
          status: allocated >= i.targetValue && i.targetValue > 0n ? 'complete' : 'partial',
          outstanding: allocated < i.targetValue ? moneyToString(i.targetValue - allocated) : undefined,
        });
      }
    } else {
      // PAYMENTS — recent fulfillments
      const fulfillments = await this.prisma.fulfillment.findMany({
        where: { eventId },
        orderBy: { occurredAt: 'desc' },
        take: 500,
        select: {
          id: true,
          value: true,
          pledge: { select: { person: { select: { displayName: true } } } },
        },
      });
      totalRecords = fulfillments.length;
      totalAmountBigInt = fulfillments.reduce((acc: bigint, f) => acc + f.value, 0n);
      for (const f of fulfillments.slice(0, limit)) {
        preview.push({
          name: f.pledge.person.displayName,
          amount: moneyToString(f.value),
          status: 'complete',
        });
      }
    }

    // ── Tier selection ────────────────────────────────────────────────────────
    let tier: PresentationTier = 'INLINE_CHAT';
    if (totalRecords > 30) tier = 'LARGE_REPORT';
    else if (totalRecords > 5) tier = 'MEDIUM_PREVIEW';

    // ── Build stateless filter URL (no DB write) ───────────────────────────────
    const params = new URLSearchParams();
    if (input.status && input.status !== 'all') params.set('status', input.status);
    if (resolvedGroupId) params.set('groupId', resolvedGroupId);
    if (input.minAmount) params.set('minAmount', String(input.minAmount));
    if (input.maxAmount) params.set('maxAmount', String(input.maxAmount));
    if (input.searchTerm) params.set('search', input.searchTerm);
    if (input.sortField) params.set('sort', input.sortField);
    if (input.sortDirection) params.set('dir', input.sortDirection);

    const pathSegment = reportTypeToPath(input.reportType);
    const qs = params.toString();
    const filterUrl = `/events/${eventId}/report/${pathSegment}${qs ? `?${qs}` : ''}`;

    // ── Build human label ────────────────────────────────────────────────────
    const statusLabel = input.status && input.status !== 'all' ? ` — ${input.status} only` : '';
    const groupLabel = resolvedGroupName ? ` (${resolvedGroupName})` : '';
    const label = `${totalRecords} ${reportTypeLabel(input.reportType)}${groupLabel}${statusLabel}`;

    const reportRef: ReportRef = {
      reportType: input.reportType,
      label,
      filterUrl,
      totalRecords,
      totalAmount: moneyToString(totalAmountBigInt),
      currency: 'UGX',
    };

    return { tier, reportRef, preview, ambiguousGroup };
  }

  /**
   * Live paginated query powering the report viewer endpoint.
   * Always queries fresh data — no snapshots.
   */
  async getPaginatedContributors(
    ctx: OperationContext,
    filters: ReportFilters,
    page: number,
    pageSize: number,
    search?: string,
  ) {
    this.permissions.assert(ctx.event.role, 'event:read');
    const eventId = ctx.event.eventId;

    let resolvedGroupId: string | undefined;
    if (filters.groupName) {
      const r = await this.resolveGroupName(eventId, filters.groupName);
      if (r.ok) resolvedGroupId = r.groupId;
    }

    const effectiveFilters = search ? { ...filters, searchTerm: search } : filters;
    const all = await this.queryContributors(eventId, effectiveFilters, resolvedGroupId);
    const totalRecords = all.length;
    const totalAmountBigInt = all.reduce((acc: bigint, r) => acc + r._received, 0n);
    const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
    const start = (page - 1) * pageSize;
    const rows = all.slice(start, start + pageSize).map((r) => {
      const owed = outstanding(r._committed, r._received);
      return {
        personId: r.id,
        name: r.displayName,
        group: r.groupName,
        amount: moneyToString(r._received),
        outstanding: owed > 0n ? moneyToString(owed) : undefined,
        status: r._committed === 0n ? 'no_pledge' : r._received >= r._committed ? 'complete' : r._received > 0n ? 'partial' : 'unpaid',
      };
    });

    return {
      totalRecords,
      totalAmount: moneyToString(totalAmountBigInt),
      currency: 'UGX' as const,
      page,
      pageSize,
      totalPages,
      rows,
    };
  }

  /** Export as CSV — always live query, same filters as the paginated endpoint */
  async exportCsv(ctx: OperationContext, filters: ReportFilters): Promise<string> {
    const data = await this.getPaginatedContributors(ctx, filters, 1, 5000);
    const lines = ['Name,Group,Amount,Outstanding,Status'];
    for (const r of data.rows) {
      const q = (s: string) => `"${(s || '').replace(/"/g, '""')}"`;
      lines.push([q(r.name), q(r.group || ''), q(r.amount), q(r.outstanding || ''), q(r.status)].join(','));
    }
    return lines.join('\n');
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async queryContributors(
    eventId: string,
    filters: ReportFilters,
    resolvedGroupId?: string,
  ): Promise<
    {
      id: string;
      displayName: string;
      groupName?: string;
      _committed: bigint;
      _received: bigint;
      _inKind: string[];
    }[]
  > {
    const people = await this.prisma.person.findMany({
      where: {
        eventId,
        ...(filters.searchTerm
          ? { displayName: { contains: filters.searchTerm, mode: 'insensitive' } }
          : {}),
        ...(resolvedGroupId
          ? { groups: { some: { groupId: resolvedGroupId } } }
          : {}),
      },
      select: {
        id: true,
        displayName: true,
        groups: {
          select: { group: { select: { name: true } } },
          take: 1,
        },
        pledges: {
          where: { status: { not: 'CANCELLED' } },
          select: {
            type: true,
            description: true,
            committedValue: true,
            fulfillments: { select: { value: true } },
          },
        },
      },
    });

    const rows = people.map((p) => {
      let committed = 0n;
      let received = 0n;
      const inKind: string[] = [];
      for (const pl of p.pledges) {
        committed += pl.committedValue;
        for (const f of pl.fulfillments) received += f.value;
        // In-kind pledges (ITEM/SERVICE) carry the real information in
        // `description`, not the money fields — surface it as its own thing
        // rather than letting it disappear into a cash total that may be 0.
        if (pl.type !== 'CASH' && pl.description) inKind.push(pl.description);
      }
      return {
        id: p.id,
        displayName: p.displayName,
        groupName: p.groups[0]?.group.name,
        _committed: committed,
        _received: received,
        _inKind: inKind,
      };
    });

    // Apply status filter (unified vocabulary: all | unpaid | partial | complete | outstanding)
    const status = filters.status ?? 'all';
    const filtered = rows.filter((r) => {
      switch (status) {
        case 'unpaid':     return r._committed > 0n && r._received === 0n;
        case 'partial':    return r._received > 0n && r._received < r._committed;
        case 'complete':   return r._committed > 0n && r._received >= r._committed;
        case 'outstanding': return outstanding(r._committed, r._received) > 0n;
        default:           return r._committed > 0n || r._received > 0n;
      }
    });

    // Apply amount filters
    const withAmounts = filtered.filter((r) => {
      if (filters.minAmount && Number(r._received) < filters.minAmount) return false;
      if (filters.maxAmount && Number(r._received) > filters.maxAmount) return false;
      return true;
    });

    // Sort
    const sortDir = filters.sortDirection === 'asc' ? 1 : -1;
    if (filters.sortField === 'name') {
      withAmounts.sort((a, b) => sortDir * a.displayName.localeCompare(b.displayName));
    } else {
      // Default: sort by received descending
      withAmounts.sort((a, b) => (a._received < b._received ? 1 : a._received > b._received ? -1 : 0) * sortDir);
    }

    return withAmounts;
  }
}

function reportTypeToPath(type: ReportType): string {
  switch (type) {
    case 'CONTRIBUTORS': return 'contributors';
    case 'OUTSTANDING':  return 'contributors';
    case 'PLEDGES':      return 'contributors';
    case 'BUDGET':       return 'budget';
    case 'PAYMENTS':     return 'payments';
  }
}

function reportTypeLabel(type: ReportType): string {
  switch (type) {
    case 'CONTRIBUTORS': return 'contributors';
    case 'OUTSTANDING':  return 'contributors with outstanding balances';
    case 'PLEDGES':      return 'pledge records';
    case 'BUDGET':       return 'budget items';
    case 'PAYMENTS':     return 'payments';
  }
}
