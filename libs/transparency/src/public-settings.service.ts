import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { BudgetVisibility, ContributorVisibility } from '@prisma/client';
import { OperationContext, PermissionService } from '@akabbo/access';
import { PrismaService } from '@akabbo/prisma';
import { AuditWriter, TenantContext } from '@akabbo/ledger';

export interface PublicSettingsView {
  slug: string;
  isPublic: boolean;
  /** Present so the organizer can share an invite-only link; null = open. */
  accessToken: string | null;
  contributorVisibility: ContributorVisibility;
  budgetVisibility: BudgetVisibility;
  /** Show the overall fundraising target (and remaining/% covered, which
   *  derive from it). Independent of budgetVisibility (the itemized budget). */
  showTarget: boolean;
  /** Show aggregate/per-contributor outstanding (amount-still-owed) figures. */
  showOutstanding: boolean;
  description: string | null;
  revision: number;
}

export interface UpdatePublicSettingsInput {
  isPublic?: boolean;
  contributorVisibility?: ContributorVisibility;
  budgetVisibility?: BudgetVisibility;
  showTarget?: boolean;
  showOutstanding?: boolean;
  description?: string | null;
}

/**
 * Organizer-side control of the public transparency page (transparency spec
 * Part 15/16/20). Every change is gated by `public:configure` (owner-tier),
 * audited old→new, and bumps `publicRevision` so caches/ETags invalidate.
 *
 * Visibility config is deliberately allowed regardless of event status — an
 * owner must be able to REVOKE a link (`isPublic=false`) after an event closes.
 */
@Injectable()
export class PublicSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
    private readonly permissions: PermissionService,
    private readonly audit: AuditWriter,
  ) {}

  async getSettings(ctx: OperationContext): Promise<PublicSettingsView> {
    this.permissions.assert(ctx.event.role, 'public:configure');
    const e = await this.prisma.event.findUniqueOrThrow({
      where: { id: ctx.event.eventId },
      select: {
        slug: true,
        isPublic: true,
        publicAccessToken: true,
        contributorVisibility: true,
        budgetVisibility: true,
        showTarget: true,
        showOutstanding: true,
        description: true,
        publicRevision: true,
      },
    });
    return this.toView(e);
  }

  async updateSettings(
    ctx: OperationContext,
    input: UpdatePublicSettingsInput,
  ): Promise<PublicSettingsView> {
    this.permissions.assert(ctx.event.role, 'public:configure');

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const before = await tx.event.findUniqueOrThrow({
        where: { id: ctx.event.eventId },
        select: {
          isPublic: true,
          contributorVisibility: true,
          budgetVisibility: true,
          showTarget: true,
          showOutstanding: true,
          description: true,
        },
      });

      const updated = await tx.event.update({
        where: { id: ctx.event.eventId },
        data: {
          isPublic: input.isPublic ?? before.isPublic,
          contributorVisibility: input.contributorVisibility ?? before.contributorVisibility,
          budgetVisibility: input.budgetVisibility ?? before.budgetVisibility,
          showTarget: input.showTarget ?? before.showTarget,
          showOutstanding: input.showOutstanding ?? before.showOutstanding,
          description: input.description === undefined ? before.description : input.description,
          publicRevision: { increment: 1 },
        },
        select: {
          slug: true,
          isPublic: true,
          publicAccessToken: true,
          contributorVisibility: true,
          budgetVisibility: true,
          showTarget: true,
          showOutstanding: true,
          description: true,
          publicRevision: true,
        },
      });

      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'public:configure',
        resourceType: 'event',
        resourceId: ctx.event.eventId,
        oldValue: {
          isPublic: before.isPublic,
          contributorVisibility: before.contributorVisibility,
          budgetVisibility: before.budgetVisibility,
          showTarget: before.showTarget,
          showOutstanding: before.showOutstanding,
        },
        newValue: {
          isPublic: updated.isPublic,
          contributorVisibility: updated.contributorVisibility,
          budgetVisibility: updated.budgetVisibility,
          showTarget: updated.showTarget,
          showOutstanding: updated.showOutstanding,
        },
      });

      return this.toView(updated);
    });
  }

  /** Turn the link invite-only by minting a fresh token (regeneration). */
  async rotateAccessToken(ctx: OperationContext): Promise<PublicSettingsView> {
    this.permissions.assert(ctx.event.role, 'public:configure');
    const token = randomBytes(16).toString('base64url');
    return this.setToken(ctx, token, 'public:token_rotate');
  }

  /** Drop the token so anyone with the slug may view again. */
  async clearAccessToken(ctx: OperationContext): Promise<PublicSettingsView> {
    this.permissions.assert(ctx.event.role, 'public:configure');
    return this.setToken(ctx, null, 'public:token_clear');
  }

  private async setToken(
    ctx: OperationContext,
    token: string | null,
    action: string,
  ): Promise<PublicSettingsView> {
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const updated = await tx.event.update({
        where: { id: ctx.event.eventId },
        data: { publicAccessToken: token, publicRevision: { increment: 1 } },
        select: {
          slug: true,
          isPublic: true,
          publicAccessToken: true,
          contributorVisibility: true,
          budgetVisibility: true,
          showTarget: true,
          showOutstanding: true,
          description: true,
          publicRevision: true,
        },
      });
      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action,
        resourceType: 'event',
        resourceId: ctx.event.eventId,
        // Never audit the secret itself — only that it changed.
        newValue: { hasToken: token !== null },
      });
      return this.toView(updated);
    });
  }

  private toView(e: {
    slug: string;
    isPublic: boolean;
    publicAccessToken: string | null;
    contributorVisibility: ContributorVisibility;
    budgetVisibility: BudgetVisibility;
    showTarget: boolean;
    showOutstanding: boolean;
    description: string | null;
    publicRevision: number;
  }): PublicSettingsView {
    return {
      slug: e.slug,
      isPublic: e.isPublic,
      accessToken: e.publicAccessToken,
      contributorVisibility: e.contributorVisibility,
      budgetVisibility: e.budgetVisibility,
      showTarget: e.showTarget,
      showOutstanding: e.showOutstanding,
      description: e.description,
      revision: e.publicRevision,
    };
  }
}
