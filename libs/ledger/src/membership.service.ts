import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventRole } from '@prisma/client';
import {
  Actor,
  EventContext,
  OperationContext,
  PermissionService,
  assertEventWritable,
} from '@akabbo/access';
import { PrismaService } from '@akabbo/prisma';
import { TenantContext } from './tenant-context.service';
import { AuditWriter } from './audit.writer';

/**
 * Identity & Access — event membership and role resolution.
 *
 * `resolveContext` is the bridge from an authenticated actor to their standing
 * in a specific event: it reads the `event_member` row under that event's RLS
 * scope, so a non-member simply sees no row and is denied. This is what every
 * request handler calls to obtain the {@link EventContext} the domain services
 * require.
 */
@Injectable()
export class MembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
    private readonly permissions: PermissionService,
    private readonly audit: AuditWriter,
  ) {}

  /**
   * Resolve an actor's role within an event, or null if they are not a member.
   * Read under the event's RLS scope, so it cannot reveal another event's
   * memberships.
   */
  async resolveContext(actor: Actor, eventId: string): Promise<EventContext | null> {
    // `event` is not RLS-scoped; read its lifecycle status so the status gate
    // (§33) is an in-memory check at every mutation.
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { status: true },
    });
    if (!event) return null;

    return this.tenant.runInEvent(eventId, async (tx) => {
      const member = await tx.eventMember.findFirst({
        // Only ACTIVE members have access; REMOVED preserves history but grants
        // nothing.
        where: { eventId, userId: actor.userId, status: 'ACTIVE' },
        select: { role: true },
      });
      return member ? { eventId, role: member.role, status: event.status } : null;
    });
  }

  /** Add (or re-role) a member. Owner-only (`member:manage`). */
  async addMember(
    ctx: OperationContext,
    targetUserId: string,
    role: EventRole,
  ): Promise<{ userId: string; role: EventRole }> {
    this.permissions.assert(ctx.event.role, 'member:manage');
    assertEventWritable(ctx.event.status);

    // Guard: the target user must exist (user table is not RLS-scoped).
    const user = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user) throw new NotFoundException('User not found');

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const existing = await tx.eventMember.findFirst({
        where: { eventId: ctx.event.eventId, userId: targetUserId },
        select: { role: true },
      });

      const member = await tx.eventMember.upsert({
        where: { eventId_userId: { eventId: ctx.event.eventId, userId: targetUserId } },
        create: {
          eventId: ctx.event.eventId,
          userId: targetUserId,
          role,
          status: 'ACTIVE',
          invitedById: ctx.actor.userId,
        },
        update: { role, status: 'ACTIVE' },
        select: { userId: true, role: true },
      });

      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: existing ? 'member:rerole' : 'member:add',
        resourceType: 'event_member',
        resourceId: targetUserId,
        oldValue: existing ? { role: existing.role } : null,
        newValue: { role },
      });

      return member;
    });
  }

  /** Update an existing member's role or status. Requires `member:manage`. */
  async updateRole(
    ctx: OperationContext,
    targetUserId: string,
    role: EventRole,
  ): Promise<{ userId: string; role: EventRole }> {
    return this.addMember(ctx, targetUserId, role);
  }

  /** List all active members of an event with their roles and user information. */
  async listMembers(
    ctx: OperationContext,
  ): Promise<Array<{ id: string; userId: string; role: EventRole; invitedAt: string; user: { phone: string } }>> {
    this.permissions.assert(ctx.event.role, 'event:read');
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const members = await tx.eventMember.findMany({
        where: { eventId: ctx.event.eventId, status: 'ACTIVE' },
        select: {
          id: true,
          userId: true,
          role: true,
          createdAt: true,
          user: { select: { phone: true } },
        },
        orderBy: { createdAt: 'asc' },
      });
      return members.map((m) => ({
        id: m.id,
        userId: m.userId,
        role: m.role,
        invitedAt: m.createdAt.toISOString(),
        user: { phone: m.user.phone },
      }));
    });
  }

  /**
   * Assert an actor is a member and return their context, or 403. Convenience
   * for handlers: resolve-or-forbid in one call.
   */
  async requireContext(actor: Actor, eventId: string): Promise<EventContext> {
    const ctx = await this.resolveContext(actor, eventId);
    if (!ctx) throw new ForbiddenException('Not a member of this event');
    return ctx;
  }
}
