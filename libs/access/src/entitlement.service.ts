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
  /** Team seats (active members + pending invites). null = unlimited. */
  maxSeats: number | null;
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

  /** The effective plan + balance for a scope. Falls back to FREE limits. */
  async resolve(scope: EntitlementScope): Promise<ResolvedEntitlement> {
    const grant = await this.activeGrant(scope);
    const plan = grant ? await this.plan(grant.planCode) : await this.plan('FREE');
    const smsBalance = await this.smsBalance(scope);
    const aiBalance = await this.aiBalance(scope);
    return {
      planCode: plan.code,
      status: grant?.status ?? GrantStatus.TRIALING,
      maxContributors: plan.maxContributors,
      maxSeats: seatsFromFeatures(plan.features),
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

  private async activeGrant(
    scope: EntitlementScope,
  ): Promise<{ planCode: string; status: GrantStatus } | null> {
    const activeStates = [GrantStatus.TRIALING, GrantStatus.ACTIVE];
    if (scope.eventId) {
      const g = await this.prisma.entitlementGrant.findFirst({
        where: { eventId: scope.eventId, status: { in: activeStates } },
        select: { status: true, plan: { select: { code: true } } },
      });
      return g ? { planCode: g.plan.code, status: g.status } : null;
    }
    if (scope.accountId) {
      // The best active grant on the account (highest-priced plan wins).
      const g = await this.prisma.entitlementGrant.findFirst({
        where: { accountId: scope.accountId, status: { in: activeStates } },
        orderBy: { plan: { priceMinor: 'desc' } },
        select: { status: true, plan: { select: { code: true } } },
      });
      return g ? { planCode: g.plan.code, status: g.status } : null;
    }
    return null;
  }

  private async smsBalance(scope: EntitlementScope): Promise<number> {
    const agg = await this.prisma.smsCreditLedger.aggregate({
      where: scope.eventId ? { eventId: scope.eventId } : { accountId: scope.accountId },
      _sum: { amount: true },
    });
    return agg._sum.amount ?? 0;
  }

  private async aiBalance(scope: EntitlementScope): Promise<number> {
    const agg = await this.prisma.aiCreditLedger.aggregate({
      where: scope.eventId ? { eventId: scope.eventId } : { accountId: scope.accountId },
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
