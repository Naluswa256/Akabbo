import { Injectable } from '@nestjs/common';
import {
  BudgetVisibility,
  ContributorVisibility,
  EventStatus,
  PaymentMethod,
  PledgeStatus,
} from '@prisma/client';
import { PrismaService } from '@akabbo/prisma';
import { TenantContext, TenantTx, moneyToString, outstanding } from '@akabbo/ledger';
import {
  PublicEventNotFoundException,
  PublicTokenRequiredException,
} from './public-access.exception';
import {
  ContributorStatus,
  PublicActivityEntry,
  PublicBudget,
  PublicBudgetItem,
  PublicContributor,
  PublicEventView,
} from './public-view';

/** Percentage of target received, one decimal; null when no usable target. */
function percentCovered(received: bigint, target: bigint | null): number | null {
  if (target === null || target <= 0n) return null;
  return Math.round((Number(received) / Number(target)) * 1000) / 10;
}

function contributorStatus(committed: bigint, received: bigint): ContributorStatus {
  if (received >= committed) return 'FULLY_PAID';
  if (received > 0n) return 'PARTIALLY_PAID';
  return 'PLEDGED';
}

/** The resolved-but-still-private event header (never returned as-is). */
interface ResolvedEvent {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  eventDate: Date | null;
  status: EventStatus;
  currency: string;
  targetAmount: bigint | null;
  contributorVisibility: ContributorVisibility;
  budgetVisibility: BudgetVisibility;
  publicRevision: number;
}

const RECENT_ACTIVITY_LIMIT = 10;
const TOP_CONTRIBUTORS_LIMIT = 100;

/**
 * Builds the PUBLIC EVENT PROJECTION (transparency spec Part 11) for the
 * unauthenticated link surface.
 *
 * SECURITY MODEL (Part 10/26):
 *  • This service is the ONE place public data is shaped. The public API can
 *    call nothing else — no write service, no member context.
 *  • It takes a public SLUG (+ optional token), never an internal id, and never
 *    an authenticated actor. A public visitor gets no role and is never an
 *    EventMember.
 *  • RLS still guarantees cross-event isolation: everything is read inside
 *    `runInEvent(eventId)`, exactly as a member read would be. The deliberate
 *    `select`s here guarantee no private FIELD (phone, note, id, audit) leaks.
 *  • The whole view is one transaction so totals can never contradict (Part 28).
 */
@Injectable()
export class PublicViewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
  ) {}

  /**
   * Resolve a public link to its event, enforcing the access rules (Part 20):
   * the event must exist AND be public; an invite-only event additionally needs
   * a matching token. The `event` table is not RLS-scoped, so this lookup needs
   * no tenant context — it is the entry gate that establishes one.
   */
  private async resolve(slug: string, token?: string): Promise<ResolvedEvent> {
    const event = await this.prisma.event.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        eventDate: true,
        status: true,
        currency: true,
        targetAmount: true,
        isPublic: true,
        publicAccessToken: true,
        contributorVisibility: true,
        budgetVisibility: true,
        publicRevision: true,
      },
    });

    // Missing OR revoked → one indistinguishable 404 (no existence oracle).
    if (!event || !event.isPublic) throw new PublicEventNotFoundException();

    // Invite-only: a token is set and must match.
    if (event.publicAccessToken !== null && token !== event.publicAccessToken) {
      throw new PublicTokenRequiredException();
    }

    return {
      id: event.id,
      slug: event.slug,
      name: event.name,
      description: event.description,
      eventDate: event.eventDate,
      status: event.status,
      currency: event.currency,
      targetAmount: event.targetAmount,
      contributorVisibility: event.contributorVisibility,
      budgetVisibility: event.budgetVisibility,
      publicRevision: event.publicRevision,
    };
  }

  /** The full public projection for a shared link. */
  async getPublicEventView(slug: string, token?: string): Promise<PublicEventView> {
    const event = await this.resolve(slug, token);

    return this.tenant.runInEvent(event.id, async (tx) => {
      // ── Financial totals (one transaction → always consistent). ──────────────
      const committedAgg = await tx.pledge.aggregate({
        where: { status: { not: PledgeStatus.CANCELLED } },
        _sum: { committedValue: true },
      });
      const receivedAgg = await tx.fulfillment.aggregate({ _sum: { value: true } });
      const totalPledged = committedAgg._sum.committedValue ?? 0n;
      const totalReceived = receivedAgg._sum.value ?? 0n;
      const target = event.targetAmount;
      const remaining = target === null ? null : outstanding(target, totalReceived);

      // ── Per-person rollup (drives count, list, activity). ────────────────────
      const people = await tx.$queryRaw<
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
      const contributorCount = people.filter((r) => r.committed > 0n).length;

      const vis = event.contributorVisibility;
      const showCount = vis !== ContributorVisibility.HIDDEN;
      const contributors = this.buildContributors(people, vis);
      const recentActivity =
        vis === ContributorVisibility.NAMES_AND_AMOUNTS ? await this.buildRecentActivity(tx) : null;

      const budget = await this.buildBudget(tx, event.budgetVisibility);

      // ── Announcements + payment instructions (public rows only). ─────────────
      const announcements = await tx.eventAnnouncement.findMany({
        where: { status: 'PUBLISHED' },
        orderBy: { publishedAt: 'desc' },
        select: { body: true, publishedAt: true },
      });
      const paymentInstructions = await tx.paymentInstruction.findMany({
        where: { isPublic: true },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
        select: { method: true, label: true, details: true },
      });

      return {
        slug: event.slug,
        name: event.name,
        description: event.description,
        eventDate: event.eventDate ? event.eventDate.toISOString() : null,
        status: event.status,
        currency: event.currency,
        target: target === null ? null : moneyToString(target),
        totalPledged: moneyToString(totalPledged),
        totalReceived: moneyToString(totalReceived),
        totalOutstanding: moneyToString(outstanding(totalPledged, totalReceived)),
        remaining: remaining === null ? null : moneyToString(remaining),
        percentCovered: percentCovered(totalReceived, target),
        contributorCount: showCount ? contributorCount : null,
        budget,
        contributors,
        recentActivity,
        announcements: announcements.map((a) => ({
          body: a.body,
          publishedAt: (a.publishedAt ?? new Date(0)).toISOString(),
        })),
        paymentInstructions: paymentInstructions.map((p) => ({
          method: p.method as PaymentMethod,
          label: p.label,
          details: p.details,
        })),
        revision: event.publicRevision,
        visibility: { contributors: vis, budget: event.budgetVisibility },
      };
    });
  }

  private buildContributors(
    people: { display_name: string; committed: bigint; received: bigint }[],
    vis: ContributorVisibility,
  ): PublicContributor[] | null {
    if (vis === ContributorVisibility.AGGREGATE_ONLY || vis === ContributorVisibility.HIDDEN) {
      return null;
    }
    // Only people who actually committed appear on the public list.
    const rows = people
      .filter((r) => r.committed > 0n)
      .sort((a, b) => (b.received === a.received ? 0 : b.received > a.received ? 1 : -1))
      .slice(0, TOP_CONTRIBUTORS_LIMIT);

    if (vis === ContributorVisibility.NAMES_ONLY) {
      return rows.map((r) => ({ displayName: r.display_name }));
    }
    // NAMES_AND_AMOUNTS
    return rows.map((r) => ({
      displayName: r.display_name,
      committed: moneyToString(r.committed),
      received: moneyToString(r.received),
      outstanding: moneyToString(outstanding(r.committed, r.received)),
      status: contributorStatus(r.committed, r.received),
    }));
  }

  private async buildRecentActivity(tx: TenantTx): Promise<PublicActivityEntry[]> {
    const rows = await tx.$queryRaw<{ display_name: string; value: bigint; occurred_at: Date }[]>`
      SELECT pr.display_name, f.value::bigint AS value, f.occurred_at
      FROM fulfillment f
      JOIN pledge pl ON f.pledge_id = pl.id
      JOIN person pr ON pl.person_id = pr.id
      WHERE pl.status <> 'CANCELLED'
      ORDER BY f.occurred_at DESC
      LIMIT ${RECENT_ACTIVITY_LIMIT}
    `;
    return rows.map((r) => ({
      displayName: r.display_name,
      value: moneyToString(r.value),
      occurredAt: r.occurred_at.toISOString(),
    }));
  }

  private async buildBudget(tx: TenantTx, vis: BudgetVisibility): Promise<PublicBudget | null> {
    if (vis === BudgetVisibility.HIDDEN) return null;

    // PARTIALLY_PUBLIC shows only lines flagged public; PUBLIC shows all.
    const onlyPublic = vis === BudgetVisibility.PARTIALLY_PUBLIC;
    const rows = await tx.$queryRaw<{ name: string; target: bigint; covered: bigint }[]>`
      SELECT bi.name,
             bi.target_value::bigint AS target,
             COALESCE((SELECT SUM(a.value) FROM allocation a
                        WHERE a.budget_item_id = bi.id), 0)::bigint AS covered
      FROM budget_item bi
      WHERE (${onlyPublic}::boolean = false OR bi.is_public = true)
      ORDER BY bi.created_at ASC
    `;

    let total = 0n;
    let coveredTotal = 0n;
    const items: PublicBudgetItem[] = rows.map((r) => {
      const remaining = outstanding(r.target, r.covered);
      total += r.target;
      coveredTotal += r.covered;
      const status: PublicBudgetItem['status'] =
        r.covered >= r.target && r.target > 0n
          ? 'FUNDED'
          : r.covered > 0n
            ? 'PARTIALLY_FUNDED'
            : 'UNFUNDED';
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
      remaining: moneyToString(outstanding(total, coveredTotal)),
      items,
    };
  }
}
