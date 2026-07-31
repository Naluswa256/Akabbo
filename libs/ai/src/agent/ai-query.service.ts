import { Injectable } from '@nestjs/common';
import { OperationContext, PermissionService } from '@akabbo/access';
import { AppConfigService } from '@akabbo/config';
import { PrismaService } from '@akabbo/prisma';
import {
  BudgetItemFunders,
  EventReport,
  GroupContribution,
  GroupService,
  LedgerQueryService,
  ReportFilters,
  ReportResult,
  ReportService,
  TenantContext,
  moneyToString,
  outstanding,
} from '@akabbo/ledger';
import { SmsService } from '@akabbo/comms';
import { EntityResolver } from '../entity-resolver.service';

/**
 * The GROUNDED READ layer for the AI operating interface (product spec Part 15,
 * 23 ANALYTICS/CONTRIBUTION read tools). Every number is computed in SQL here —
 * the LLM only phrases the result (§3.8) and can never invent a figure. All
 * reads run under the event's RLS scope and are permission-gated exactly like
 * the typed API, so the AI has no privileged path.
 *
 * These are the deterministic tools the agent calls to ANSWER questions; the
 * WRITE path stays in the capture/confirmation pipeline.
 */
@Injectable()
export class AiQueryService {
  constructor(
    private readonly queries: LedgerQueryService,
    private readonly tenant: TenantContext,
    private readonly permissions: PermissionService,
    private readonly resolver: EntityResolver,
    private readonly groups: GroupService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly reports: ReportService,
    private readonly sms: SmsService,
  ) {}

  /**
   * Execute a stateless report query. Returns a `ReportResult` with:
   * - `tier`: INLINE_CHAT | MEDIUM_PREVIEW | LARGE_REPORT
   * - `reportRef`: stateless URL + label for the frontend chip button
   * - `preview`: top-5 rows for inline chat summary
   * - `ambiguousGroup?`: candidates when groupName matches 0 or 2+ groups
   */
  async queryEventReport(ctx: OperationContext, input: ReportFilters): Promise<ReportResult> {
    return this.reports.generateReport(ctx, input);
  }

  /** The whole "how are we doing?" picture (Part 1/2/9/15/17). */
  overview(ctx: OperationContext): Promise<EventReport> {
    return this.queries.getEventReport(ctx);
  }

  /**
   * The event's PUBLIC/shareable link (transparency spec). Returns the slug +
   * ready-to-share URL (invite-only events include their access token). If the
   * public page is turned off, says so instead of handing out a dead link.
   */
  async getPublicLink(ctx: OperationContext): Promise<{
    isPublic: boolean;
    slug: string;
    publicPath: string;
    publicUrl: string | null;
    tokenRequired: boolean;
    note?: string;
  }> {
    this.permissions.assert(ctx.event.role, 'event:read');
    // `event` is not RLS-scoped — read it directly.
    const event = await this.prisma.event.findUniqueOrThrow({
      where: { id: ctx.event.eventId },
      select: { slug: true, isPublic: true, publicAccessToken: true },
    });
    const query = event.publicAccessToken ? `?t=${event.publicAccessToken}` : '';
    const publicPath = `/e/${event.slug}${query}`;
    const base = this.config.get('PUBLIC_APP_URL');
    return {
      isPublic: event.isPublic,
      slug: event.slug,
      publicPath,
      publicUrl: base ? `${base.replace(/\/$/, '')}${publicPath}` : null,
      tokenRequired: event.publicAccessToken !== null,
      note: event.isPublic
        ? undefined
        : 'The public page is currently turned OFF — turn it on to share this link.',
    };
  }

  /** Per-group contribution rollup ("how much has the bride's side given?", §9). */
  groupContributions(ctx: OperationContext): Promise<GroupContribution[]> {
    return this.groups.groupContributions(ctx);
  }

  /**
   * SMS delivery ground truth — "did it send, and to who?" (§21/§34). The AI
   * must call this before ever telling the user whether a reminder or
   * announcement was delivered; it must never narrate a plausible-sounding
   * status from memory. Pass `campaignId` to check one specific blast, or omit
   * it to see every campaign plus the full delivery breakdown across all of
   * them. Names only — phone numbers never surface here (§3.10).
   */
  async getSmsStatus(
    ctx: OperationContext,
    campaignId?: string,
  ): Promise<{
    campaigns: unknown[];
    delivery: { sent: string[]; failed: string[]; pending: string[] };
  }> {
    const [campaigns, delivery] = await Promise.all([
      this.sms.listCampaigns(ctx),
      this.sms.delivery(ctx, campaignId),
    ]);
    return { campaigns, delivery };
  }

  /**
   * A named contributor's standing (Part 3/5/15). Resolution never guesses: an
   * ambiguous name returns the candidates so the agent can ask "which one?"
   * (Part 5/27). An unknown name returns `not_found` — the agent says so rather
   * than inventing (Part 32).
   */
  async findContributor(
    ctx: OperationContext,
    name: string,
  ): Promise<
    | { status: 'not_found'; name: string }
    | { status: 'ambiguous'; candidates: { displayName: string }[] }
    | {
        status: 'found';
        displayName: string;
        committed: string;
        received: string;
        outstanding: string;
        pledgeStatus: 'PLEDGED' | 'PARTIALLY_PAID' | 'FULLY_PAID' | 'NO_PLEDGE';
        paymentCount: number;
        byMethod: { method: string; total: string }[];
      }
  > {
    this.permissions.assert(ctx.event.role, 'ledger:read_amounts');
    const resolution = await this.resolver.resolvePerson(ctx.event.eventId, name);
    if (resolution.status === 'ambiguous') {
      return {
        status: 'ambiguous',
        candidates: resolution.candidates.map((c) => ({ displayName: c.displayName })),
      };
    }
    if (resolution.status !== 'resolved') return { status: 'not_found', name };

    const personId = resolution.personId;
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const agg = await tx.$queryRaw<{ committed: bigint; received: bigint; payments: bigint }[]>`
        SELECT
          COALESCE((SELECT SUM(pl.committed_value) FROM pledge pl
                     WHERE pl.person_id = ${personId}::uuid AND pl.status <> 'CANCELLED'), 0)::bigint AS committed,
          COALESCE((SELECT SUM(f.value) FROM fulfillment f
                     JOIN pledge pl2 ON f.pledge_id = pl2.id
                     WHERE pl2.person_id = ${personId}::uuid AND pl2.status <> 'CANCELLED'), 0)::bigint AS received,
          COALESCE((SELECT COUNT(*) FROM fulfillment f
                     JOIN pledge pl3 ON f.pledge_id = pl3.id
                     WHERE pl3.person_id = ${personId}::uuid AND pl3.status <> 'CANCELLED'), 0)::bigint AS payments
      `;
      const committed = agg[0]?.committed ?? 0n;
      const received = agg[0]?.received ?? 0n;
      const paymentCount = Number(agg[0]?.payments ?? 0n);

      const methods = await tx.$queryRaw<{ method: string; total: bigint }[]>`
        SELECT f.method::text AS method, SUM(f.value)::bigint AS total
        FROM fulfillment f
        JOIN pledge pl ON f.pledge_id = pl.id
        WHERE pl.person_id = ${personId}::uuid AND pl.status <> 'CANCELLED'
        GROUP BY f.method
        ORDER BY total DESC
      `;

      const pledgeStatus =
        committed === 0n
          ? 'NO_PLEDGE'
          : received >= committed
            ? 'FULLY_PAID'
            : received > 0n
              ? 'PARTIALLY_PAID'
              : 'PLEDGED';

      return {
        status: 'found' as const,
        displayName: resolution.displayName,
        committed: moneyToString(committed),
        received: moneyToString(received),
        outstanding: moneyToString(outstanding(committed, received)),
        pledgeStatus,
        paymentCount,
        byMethod: methods.map((m) => ({ method: m.method, total: moneyToString(m.total) })),
      };
    });
  }

  /**
   * Filtered contributor list (Part 3/10/15). `status` interpretation is
   * explicit (Part 10): `unpaid` = committed but nothing received; `partial` =
   * some but not all; `complete` = fully paid; `outstanding` = anything still
   * owed. The agent surfaces which interpretation it used.
   */
  async listContributors(
    ctx: OperationContext,
    filter: { status?: 'all' | 'unpaid' | 'partial' | 'complete' | 'outstanding'; limit?: number },
  ): Promise<{
    interpretation: string;
    count: number;
    contributors: {
      displayName: string;
      committed: string;
      received: string;
      outstanding: string;
    }[];
  }> {
    this.permissions.assert(ctx.event.role, 'ledger:read_amounts');
    const status = filter.status ?? 'all';
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const rows = await tx.$queryRaw<
        { display_name: string; committed: bigint; received: bigint }[]
      >`
        SELECT p.display_name,
               COALESCE((SELECT SUM(pl.committed_value) FROM pledge pl
                          WHERE pl.person_id = p.id AND pl.status <> 'CANCELLED'), 0)::bigint AS committed,
               COALESCE((SELECT SUM(f.value) FROM fulfillment f
                          JOIN pledge pl2 ON f.pledge_id = pl2.id
                          WHERE pl2.person_id = p.id AND pl2.status <> 'CANCELLED'), 0)::bigint AS received
        FROM person p
      `;

      const withBal = rows.map((r) => ({
        displayName: r.display_name,
        committed: r.committed,
        received: r.received,
        owed: outstanding(r.committed, r.received),
      }));

      const match = withBal.filter((r) => {
        switch (status) {
          case 'unpaid':
            return r.committed > 0n && r.received === 0n;
          case 'partial':
            return r.received > 0n && r.received < r.committed;
          case 'complete':
            return r.committed > 0n && r.received >= r.committed;
          case 'outstanding':
            return r.owed > 0n;
          default:
            return r.committed > 0n;
        }
      });

      match.sort((a, b) => (b.owed === a.owed ? 0 : b.owed > a.owed ? 1 : -1));
      const interpretation: Record<typeof status, string> = {
        all: 'everyone who has pledged',
        unpaid: 'pledged but paid nothing yet',
        partial: 'paid some but not all of their pledge',
        complete: 'fully paid their pledge',
        outstanding: 'still owe something on their pledge',
      };

      return {
        interpretation: interpretation[status],
        count: match.length,
        contributors: match.slice(0, limit).map((r) => ({
          displayName: r.displayName,
          committed: moneyToString(r.committed),
          received: moneyToString(r.received),
          outstanding: moneyToString(r.owed),
        })),
      };
    });
  }

  /**
   * Money received within a date window (Part 1 time-based). Boundaries are
   * ISO-8601 UTC; the caller (agent) resolves "this week"/"December" against the
   * event timezone before calling. Half-open `[from, to)`.
   */
  async collectedInPeriod(
    ctx: OperationContext,
    fromIso: string,
    toIso: string,
  ): Promise<{ from: string; to: string; total: string; paymentCount: number }> {
    this.permissions.assert(ctx.event.role, 'ledger:read_amounts');
    const from = new Date(fromIso);
    const to = new Date(toIso);
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const agg = await tx.fulfillment.aggregate({
        where: { occurredAt: { gte: from, lt: to } },
        _sum: { value: true },
        _count: true,
      });
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        total: moneyToString(agg._sum.value ?? 0n),
        paymentCount: agg._count,
      };
    });
  }

  /** Budget with per-item coverage and gaps (Part 6/8/9). */
  async budgetBreakdown(ctx: OperationContext): Promise<{
    total: string;
    covered: string;
    unfunded: string;
    items: {
      name: string;
      target: string;
      covered: string;
      remaining: string;
      status: 'FUNDED' | 'PARTIALLY_FUNDED' | 'UNFUNDED';
    }[];
  }> {
    this.permissions.assert(ctx.event.role, 'budget:read');
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const rows = await tx.$queryRaw<{ name: string; target: bigint; covered: bigint }[]>`
        SELECT bi.name,
               bi.target_value::bigint AS target,
               COALESCE((SELECT SUM(a.value) FROM allocation a
                          WHERE a.budget_item_id = bi.id), 0)::bigint AS covered
        FROM budget_item bi
        ORDER BY bi.target_value DESC
      `;
      let total = 0n;
      let coveredTotal = 0n;
      const items = rows.map((r) => {
        total += r.target;
        coveredTotal += r.covered;
        const remaining = outstanding(r.target, r.covered);
        const status =
          r.covered >= r.target && r.target > 0n
            ? ('FUNDED' as const)
            : r.covered > 0n
              ? ('PARTIALLY_FUNDED' as const)
              : ('UNFUNDED' as const);
        return {
          name: r.name,
          target: moneyToString(r.target),
          covered: moneyToString(r.covered),
          remaining: moneyToString(remaining),
          status,
        };
      });
      return {
        total: moneyToString(total),
        covered: moneyToString(coveredTotal),
        unfunded: moneyToString(outstanding(total, coveredTotal)),
        items,
      };
    });
  }

  /** Who actually funded a budget line — see LedgerQueryService.getBudgetItemFunders. */
  budgetItemFunders(ctx: OperationContext, itemName: string): Promise<BudgetItemFunders> {
    return this.queries.getBudgetItemFunders(ctx, itemName);
  }
}
