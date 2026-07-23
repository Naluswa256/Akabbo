import { randomBytes } from 'node:crypto';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventRole, InvitationStatus, MembershipStatus } from '@prisma/client';
import {
  Actor,
  EntitlementService,
  OperationContext,
  PermissionService,
  assertEventWritable,
} from '@akabbo/access';
import { PrismaService } from '@akabbo/prisma';
import { TenantContext } from './tenant-context.service';
import { AuditWriter } from './audit.writer';

export interface CreateInvitationInput {
  role: EventRole;
  /** Optional target phone (display / future SMS). */
  invitedPhone?: string;
  /** Single-use by default. */
  maxUses?: number;
  /** Time-to-live in seconds (default 7 days). */
  ttlSeconds?: number;
}

export interface InvitationView {
  id: string;
  token: string;
  role: EventRole;
  status: InvitationStatus;
  expiresAt: string;
}

/** What the PUBLIC landing page shows before the invitee authenticates. */
export interface PublicInvitationView {
  eventName: string;
  role: EventRole;
  status: InvitationStatus;
  valid: boolean;
}

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Team invitations (blueprint §4, §5, §36). An invitation PRECEDES membership:
 * you can invite someone who has no account yet. The unguessable `token` is the
 * capability — a leaked link is inert until the invitee completes OTP and
 * accepts. The `invitation` table is deliberately NOT under event-RLS (the
 * invitee is not a member yet); reads are by token, writes are permission-gated.
 */
@Injectable()
export class InvitationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
    private readonly permissions: PermissionService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditWriter,
  ) {}

  /** Create a share-link invitation. Owner/co-owner only (`member:manage`). */
  async createInvitation(
    ctx: OperationContext,
    input: CreateInvitationInput,
  ): Promise<InvitationView> {
    this.permissions.assert(ctx.event.role, 'member:manage');
    assertEventWritable(ctx.event.status);
    // Seat gate (metering §7): don't invite past the plan's team-seat allowance.
    const seat = await this.entitlements.check({ eventId: ctx.event.eventId }, 'add_member');
    if (!seat.allowed) {
      throw new ForbiddenException(seat.message ?? 'Team seat limit reached');
    }
    const token = randomBytes(24).toString('base64url');
    const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const invitation = await this.prisma.invitation.create({
      data: {
        eventId: ctx.event.eventId,
        token,
        role: input.role,
        invitedPhone: input.invitedPhone ?? null,
        invitedById: ctx.actor.userId,
        maxUses: input.maxUses ?? 1,
        expiresAt: new Date(Date.now() + ttl * 1000),
      },
      select: { id: true, token: true, role: true, status: true, expiresAt: true },
    });
    return { ...invitation, expiresAt: invitation.expiresAt.toISOString() };
  }

  /** Public, pre-auth view for the landing page. Leaks only event name + role. */
  async getByToken(token: string): Promise<PublicInvitationView> {
    const inv = await this.prisma.invitation.findUnique({
      where: { token },
      select: { role: true, status: true, expiresAt: true, event: { select: { name: true } } },
    });
    if (!inv) throw new NotFoundException('Invitation not found');
    const valid = inv.status === InvitationStatus.PENDING && inv.expiresAt.getTime() > Date.now();
    return { eventName: inv.event.name, role: inv.role, status: inv.status, valid };
  }

  /**
   * Accept an invitation as the authenticated actor (already phone-verified via
   * OTP). Creates the membership under the event's RLS scope — the token, not
   * prior membership, is the authority. Idempotent: an existing member returns
   * success without consuming a use; a fully-used/expired/revoked token is
   * rejected.
   */
  async acceptInvitation(
    actor: Actor,
    token: string,
  ): Promise<{ eventId: string; role: EventRole; alreadyMember: boolean }> {
    const inv = await this.prisma.invitation.findUnique({ where: { token } });
    if (!inv) throw new NotFoundException('Invitation not found');
    if (inv.status === InvitationStatus.REVOKED) {
      throw new ForbiddenException('This invitation has been revoked');
    }
    if (inv.status === InvitationStatus.EXPIRED || inv.expiresAt.getTime() <= Date.now()) {
      if (inv.status !== InvitationStatus.EXPIRED) {
        await this.prisma.invitation.update({
          where: { id: inv.id },
          data: { status: InvitationStatus.EXPIRED },
        });
      }
      throw new ForbiddenException('This invitation has expired');
    }

    return this.tenant.runInEvent(inv.eventId, async (tx) => {
      const existing = await tx.eventMember.findFirst({
        where: { eventId: inv.eventId, userId: actor.userId },
        select: { id: true, role: true, status: true },
      });

      // Idempotent: already an active member → no-op success, no use consumed.
      if (existing && existing.status === MembershipStatus.ACTIVE) {
        return { eventId: inv.eventId, role: existing.role, alreadyMember: true };
      }

      // A single-use token that is already consumed cannot admit a new member.
      if (inv.uses >= inv.maxUses) {
        throw new ForbiddenException('This invitation has already been used');
      }

      const member = await tx.eventMember.upsert({
        where: { eventId_userId: { eventId: inv.eventId, userId: actor.userId } },
        create: {
          eventId: inv.eventId,
          userId: actor.userId,
          role: inv.role,
          status: MembershipStatus.ACTIVE,
          invitedById: inv.invitedById,
        },
        update: { role: inv.role, status: MembershipStatus.ACTIVE, invitedById: inv.invitedById },
        select: { role: true },
      });

      const uses = inv.uses + 1;
      await tx.invitation.update({
        where: { id: inv.id },
        data: {
          uses,
          status: uses >= inv.maxUses ? InvitationStatus.ACCEPTED : InvitationStatus.PENDING,
          acceptedById: actor.userId,
          acceptedAt: new Date(),
        },
      });

      await this.audit.write(tx, {
        eventId: inv.eventId,
        actorUserId: actor.userId,
        action: 'member:accept_invitation',
        resourceType: 'event_member',
        resourceId: actor.userId,
        newValue: { role: member.role, invitationId: inv.id },
      });

      return { eventId: inv.eventId, role: member.role, alreadyMember: false };
    });
  }

  /** Revoke a pending invitation. Owner/co-owner only. */
  async revokeInvitation(ctx: OperationContext, invitationId: string): Promise<void> {
    this.permissions.assert(ctx.event.role, 'member:manage');
    const inv = await this.prisma.invitation.findFirst({
      where: { id: invitationId, eventId: ctx.event.eventId },
      select: { id: true },
    });
    if (!inv) throw new NotFoundException('Invitation not found');
    await this.prisma.invitation.update({
      where: { id: inv.id },
      data: { status: InvitationStatus.REVOKED },
    });
  }

  /** List an event's invitations. Owner/co-owner only. */
  async listInvitations(ctx: OperationContext): Promise<InvitationView[]> {
    this.permissions.assert(ctx.event.role, 'member:manage');
    const rows = await this.prisma.invitation.findMany({
      where: { eventId: ctx.event.eventId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, token: true, role: true, status: true, expiresAt: true },
    });
    return rows.map((r) => ({ ...r, expiresAt: r.expiresAt.toISOString() }));
  }
}
