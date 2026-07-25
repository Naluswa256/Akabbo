import { Injectable } from '@nestjs/common';
import { GrantStatus, InvitationStatus, MembershipStatus } from '@prisma/client';
import { PrismaService } from '@akabbo/prisma';
import { PLAN_CATALOG } from '@akabbo/config';

/**
 * Derive the team-seat allowance from a plan's feature flags (metering §4/§7:
 * "seats = active event_member count"). `unlimited_seats` → no cap; `seats_N` →
 * N; no seat feature (Free) → 1 (the solo organizer only).
 */
function seatsFromFeatures(features: string[]): number | null {
  if (features.includes('unlimited_seats')) return null;
  const seatFeat = features.find((f) => /^seats_\d+$/.test(f));
  return seatFeat ? Number.parseInt(seatFeat.split('_')[1], 10) : 1;
}

/**
 * Entitlement scope — a plan attaches to EITHER an event or an account
 * (scope-agnostic, no special-casing — metering doc §7.1).
 */
export interface EntitlementScope {
  eventId?: string;
  accountId?: string;
}

/**
 * Entitlement-checked actions (distinct from permission Actions): "does your
 * plan permit / can you afford it?" rather than "are you allowed?".
 */
export type EntitlementAction =
  | 'add_contributor'
  | 'add_member'
  | 'create_pledge'
  | 'record_fulfillment'
  | 'send_sms'
  | 'use_ai';

export interface EntitlementDecision {
  allowed: boolean;
  /** Machine-readable reason when denied (e.g. 'contributor_limit'). */
  reason?: string;
  /** Human-facing upgrade/top-up prompt when denied. */
  message?: string;
}

/** The effective limits for a scope (metering doc §7.1 "entitlement (resolved)"). */
export interface ResolvedEntitlement {
  planCode: string;
  status: GrantStatus;
  /** null = unlimited/soft cap (Premium/Business). */
  maxContributors: number | null;
  /** Live count of event contributors (person records). */
  currentContributors: number;
  /** Team seats (active members + pending invites). null = unlimited. */
  maxSeats: number | null;
  /** Live count of team seats currently in use. */
  currentSeats: number;
  features: string[];
  /** Current SMS-credit balance for the scope (SUM of the append-only ledger). */
  smsBalance: number;
  /** Current AI-credit balance for the scope (SUM of the append-only AI credit ledger). */
  aiBalance: number;
  /** Total bundled AI credits for the scope's plan. */
  maxAiCredits: number;
}

/**
 * The SECOND deterministic gate (§3.6). Parallel to permission: permission asks
 * "are you allowed?", entitlement asks "does your plan permit / can you afford
 * it?". Both run in code, before the domain service acts.
 *
 * Phase-5 REAL implementation (metering doc §7.2): resolves the scope's active
 * grant → plan limits + SMS balance, then enforces the two dials we price on —
 * **contributor count** and **SMS credits**. AI and ordinary pledges/payments are
 * NOT gated (metering doc §1: give AI away, charge for reach + scale). A scope
 * with no active grant falls back to FREE-tier limits (fail-safe, not fail-open):
 * unknown scopes still get capped, never unlimited.
 */
@Injectable()
export class EntitlementService {
  private planCache: Map<string, PlanRow> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async check(
    scope: EntitlementScope,
    action: EntitlementAction,
    quantity = 1,
  ): Promise<EntitlementDecision> {
    // Only reach (contributors) and SMS are metered; everything else proceeds
    // (metering doc §7.2 — AI + pledges/payments are never entitlement-gated).
    if (action === 'create_pledge' || action === 'record_fulfillment') {
      return { allowed: true };
    }

    const ent = await this.resolve(scope);

    if (action === 'use_ai') {
      if (ent.aiBalance < quantity) {
        return {
          allowed: false,
          reason: 'ai_credits',
          message:
            'Chat feature locked — 0 AI credits remaining. Purchase an AI Top-Up or upgrade your plan to continue using conversational features.',
        };
      }
      return { allowed: true };
    }

    if (action === 'add_contributor') {
      if (ent.maxContributors === null) return { allowed: true };
      const current = scope.eventId ? await this.countContributors(scope.eventId) : 0;
      if (current + quantity > ent.maxContributors) {
        return {
          allowed: false,
          reason: 'contributor_limit',
          message: `Your ${ent.planCode} plan allows ${ent.maxContributors} contributors. Upgrade to add more.`,
        };
      }
      return { allowed: true };
    }

    if (action === 'add_member') {
      if (ent.maxSeats === null) return { allowed: true };
      const used = scope.eventId ? await this.countSeats(scope.eventId) : 0;
      if (used + quantity > ent.maxSeats) {
        return {
          allowed: false,
          reason: 'seat_limit',
          message: `Your ${ent.planCode} plan includes ${ent.maxSeats} team seat${
            ent.maxSeats === 1 ? '' : 's'
          }. Upgrade to add more people to the team.`,
        };
      }
      return { allowed: true };
    }

    if (action === 'send_sms') {
      if (ent.smsBalance < quantity) {
        return {
          allowed: false,
          reason: 'sms_credits',
          message: "You're out of SMS credits — top up to send more.",
        };
      }
      return { allowed: true };
    }

    return { allowed: true };
  }

  /**
   * The effective plan + balance for a scope. Falls back to FREE limits.
   * `owningAccountId` is resolved ONCE here and threaded through — resolving
   * it separately per lookup (as this used to) meant two `findFirst` calls
   * with no explicit ordering could each pick a DIFFERENT account row if a
   * user ever ends up with more than one (no unique constraint on
   * ownerUserId today), making a single `resolve()` call internally
   * inconsistent with itself, e.g. `activeGrant` reporting a paid plan while
   * `aiBalance` reads a balance of 0 from a different, empty account.
   */
  async resolve(scope: EntitlementScope): Promise<ResolvedEntitlement> {
    const accountId =
      scope.accountId ?? (scope.eventId ? await this.owningAccountId(scope.eventId) : null);
    const grant = await this.activeGrant(scope, accountId);
    const plan = grant ? await this.plan(grant.planCode) : await this.plan('FREE');
    const smsBalance = await this.smsBalance(scope, accountId);
    const aiBalance = await this.aiBalance(scope, accountId);
    const currentContributors = scope.eventId ? await this.countContributors(scope.eventId) : 0;
    const currentSeats = scope.eventId ? await this.countSeats(scope.eventId) : 0;
    return {
      planCode: plan.code,
      status: grant?.status ?? GrantStatus.TRIALING,
      maxContributors: plan.maxContributors,
      currentContributors,
      maxSeats: seatsFromFeatures(plan.features),
      currentSeats,
      features: plan.features,
      smsBalance,
      aiBalance,
      maxAiCredits: plan.includedAiCredits,
    };
  }

  /** Seats in use for an event = ACTIVE members + still-valid PENDING invites. */
  private async countSeats(eventId: string): Promise<number> {
    const members = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_event_id', ${eventId}, true)`;
      return tx.eventMember.count({ where: { status: MembershipStatus.ACTIVE } });
    });
    // Invitations are NOT event-RLS-scoped (invitee isn't a member yet) — read direct.
    const pending = await this.prisma.invitation.count({
      where: { eventId, status: InvitationStatus.PENDING, expiresAt: { gt: new Date() } },
    });
    return members + pending;
  }

  /**
   * The best active grant visible to this scope — pooling the event's OWN
   * grant (e.g. a purchased event pack) with its owning ACCOUNT's grant (e.g.
   * a Business subscription, or the account-level free trial). Without this,
   * a paying subscriber's account grant is invisible the moment a check is
   * made with `{eventId}` (which is every real call site), and they'd
   * silently fall back to FREE-tier limits on every event — paying for a
   * plan that never actually applies. When both exist, the higher-priced
   * plan wins (same tie-break already used across multiple account grants).
   */
  private async activeGrant(
    scope: EntitlementScope,
    accountId: string | null,
  ): Promise<{ planCode: string; status: GrantStatus } | null> {
    const activeStates = [GrantStatus.TRIALING, GrantStatus.ACTIVE];
    const eventId = scope.eventId;
    const targetAccountId = scope.accountId ?? accountId;

    if (!eventId && !targetAccountId) return null;

    const candidates = await this.prisma.entitlementGrant.findMany({
      where: {
        status: { in: activeStates },
        OR: [
          ...(eventId ? [{ eventId }] : []),
          ...(targetAccountId ? [{ accountId: targetAccountId }] : []),
        ],
      },
      orderBy: { plan: { priceMinor: 'desc' } },
      select: { status: true, plan: { select: { code: true } } },
      take: 1,
    });
    const g = candidates[0];
    return g ? { planCode: g.plan.code, status: g.status } : null;
  }

  /**
   * The event's owning account, if it has one — so a balance check on an
   * event can also see credits granted at the ACCOUNT level (the free trial
   * is granted ONCE per account at signup, not per event; see BillingService
   * .startAccountTrial). Ledger DEBITS (reserve/deduct) stay event-scoped for
   * a clean per-event audit trail — only the balance READ needs to pool both.
   *
   * `ownerUserId` has no unique constraint on `billing_account` today, so if a
   * user ever ends up with more than one row, `orderBy: createdAt asc` makes
   * every lookup in this service agree on the SAME one (the original,
   * longest-lived account) instead of an unordered `LIMIT 1` that Postgres
   * gives no guarantee will return the same row twice.
   */
  async owningAccountId(eventId: string): Promise<string | null> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { ownerUserId: true },
    });
    if (!event) return null;
    const account = await this.prisma.billingAccount.findFirst({
      where: { ownerUserId: event.ownerUserId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return account?.id ?? null;
  }

  /** Ledger rows for either scope key, pooled — see {@link owningAccountId}. */
  private scopeWhere(
    scope: EntitlementScope,
    accountId: string | null,
  ): { eventId?: string; accountId?: string }[] {
    const targetAccountId = scope.accountId ?? accountId;
    const OR: { eventId?: string; accountId?: string }[] = [];
    if (scope.eventId) OR.push({ eventId: scope.eventId });
    if (targetAccountId) OR.push({ accountId: targetAccountId });
    return OR;
  }

  private async smsBalance(scope: EntitlementScope, accountId: string | null): Promise<number> {
    const OR = this.scopeWhere(scope, accountId);
    if (OR.length === 0) return 0;
    const agg = await this.prisma.smsCreditLedger.aggregate({
      where: { OR },
      _sum: { amount: true },
    });
    return agg._sum.amount ?? 0;
  }

  private async aiBalance(scope: EntitlementScope, accountId: string | null): Promise<number> {
    const OR = this.scopeWhere(scope, accountId);
    if (OR.length === 0) return 0;
    const agg = await this.prisma.aiCreditLedger.aggregate({
      where: { OR },
      _sum: { amount: true },
    });
    return agg._sum.amount ?? 0;
  }

  /** Count contributors within the event's RLS scope (own short transaction). */
  private countContributors(eventId: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_event_id', ${eventId}, true)`;
      return tx.person.count();
    });
  }

  /** Memoised plan catalog (seeded, static). */
  private async plan(code: string): Promise<PlanRow> {
    if (!this.planCache) {
      const rows = await this.prisma.plan.findMany({
        select: {
          code: true,
          maxContributors: true,
          features: true,
          includedSmsCredits: true,
          includedAiCredits: true,
        },
      });
      this.planCache = new Map(rows.map((r) => [r.code, r]));
    }
    const found = this.planCache.get(code);
    const config = PLAN_CATALOG[code] ?? PLAN_CATALOG.FREE;
    return (
      found ?? {
        code: config.code,
        maxContributors: config.maxContributors,
        includedSmsCredits: config.includedSmsCredits,
        includedAiCredits: config.includedAiCredits,
        features: config.features,
      }
    );
  }
}

interface PlanRow {
  code: string;
  maxContributors: number | null;
  includedSmsCredits: number;
  includedAiCredits: number;
  features: string[];
}
