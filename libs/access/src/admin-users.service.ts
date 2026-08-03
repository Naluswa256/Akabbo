import { Injectable } from '@nestjs/common';
import { PrismaService } from '@akabbo/prisma';
import { EntitlementService } from './entitlement.service';

export interface AdminUserRow {
  id: string;
  phone: string | null;
  phoneVerified: boolean;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  createdAt: string;
  planCode: string;
  planStatus: string;
  aiBalance: number;
  smsBalance: number;
  ownedEventCount: number;
}

export interface AdminUsersSummary {
  totalUsers: number;
  /** Users whose best account-level grant is still TRIALING (never paid). */
  onFreeTrial: number;
  /** Users with an ACTIVE (paid) grant. */
  onPaidPlan: number;
  /** Per-plan-code counts, e.g. { FREE: 12, STARTER: 3, BUSINESS: 1 }. */
  byPlan: Record<string, number>;
}

/**
 * Admin reporting: who's on the platform, and what are they actually paying
 * for (metering doc — visibility the founder needs, not something any normal
 * user-scoped endpoint can answer). Read-only everywhere: unlike
 * BillingService.ensureBillingAccount, nothing here ever creates a
 * billing_account row just because an admin looked at the list.
 *
 * N+1 by design (one entitlement resolve per user) — this reuses the exact
 * same plan-resolution logic every other part of the app trusts
 * (EntitlementService.resolve), rather than a second, faster but
 * independently-maintained query that could quietly drift from it. Fine at
 * current scale for a low-traffic admin view; revisit if the user count ever
 * makes this slow.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
  ) {}

  async listUsers(limit = 200): Promise<AdminUserRow[]> {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        phone: true,
        phoneVerified: true,
        email: true,
        emailVerified: true,
        displayName: true,
        createdAt: true,
        _count: { select: { ownedEvents: true } },
      },
    });

    const rows: AdminUserRow[] = [];
    for (const u of users) {
      const accountId = await this.entitlements.findAccountId(u.id);
      const ent = await this.entitlements.resolve(accountId ? { accountId } : {});
      rows.push({
        id: u.id,
        phone: u.phone,
        phoneVerified: u.phoneVerified,
        email: u.email,
        emailVerified: u.emailVerified,
        displayName: u.displayName,
        createdAt: u.createdAt.toISOString(),
        planCode: ent.planCode,
        planStatus: ent.status,
        aiBalance: ent.aiBalance,
        smsBalance: ent.smsBalance,
        ownedEventCount: u._count.ownedEvents,
      });
    }
    return rows;
  }

  async summary(): Promise<AdminUsersSummary> {
    const rows = await this.listUsers(1000);
    const byPlan: Record<string, number> = {};
    let onFreeTrial = 0;
    let onPaidPlan = 0;
    for (const r of rows) {
      byPlan[r.planCode] = (byPlan[r.planCode] ?? 0) + 1;
      if (r.planStatus === 'TRIALING') onFreeTrial += 1;
      if (r.planStatus === 'ACTIVE') onPaidPlan += 1;
    }
    return { totalUsers: rows.length, onFreeTrial, onPaidPlan, byPlan };
  }
}
