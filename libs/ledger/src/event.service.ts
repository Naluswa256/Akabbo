import { randomBytes } from 'node:crypto';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventRole, EventStatus, Prisma } from '@prisma/client';
import { Actor, OperationContext, PermissionService, assertEventWritable } from '@akabbo/access';
import { PrismaService } from '@akabbo/prisma';
import { TenantContext } from './tenant-context.service';
import { AuditWriter } from './audit.writer';
import { moneyToString } from './money';

export interface CreateEventInput {
  name: string;
  currency?: string;
  /** Target contribution amount in minor units (§2: "25 million"). */
  targetAmount?: bigint;
  eventDate?: Date;
  timezone?: string;
  country?: string;
}

export interface UpdateEventInput {
  name?: string;
  targetAmount?: bigint;
  eventDate?: Date;
}

export interface EventSummary {
  id: string;
  name: string;
  slug: string;
  status: EventStatus;
  currency: string;
  targetAmount: string | null;
  eventDate: string | null;
  timezone: string;
  country: string;
  ownerUserId: string;
}

/** URL-safe slug from a name plus a short random suffix to avoid collisions. */
function makeSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const suffix = randomBytes(4).toString('hex');
  return `${base || 'event'}-${suffix}`;
}

/**
 * Event lifecycle (Identity & Access). Creating an event also makes its creator
 * the OWNER and records the creation in the audit trail — all in one
 * transaction, so an event never exists without an owner or without provenance.
 *
 * Contribution collection is an EVENT STATE (§12), not a separate campaign
 * object. CLOSED/ARCHIVED are read-only (§33) — enforced by the status gate.
 */
@Injectable()
export class EventService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
    private readonly permissions: PermissionService,
    private readonly audit: AuditWriter,
  ) {}

  async createEvent(actor: Actor, input: CreateEventInput): Promise<EventSummary> {
    const currency = input.currency ?? 'UGX';
    // Plan gate (metering §10): the free tier covers ONE active event. This is
    // keyed on the OWNER, so it can't be reset by a new login/token/conversation.
    // A subscription raises the ceiling.
    await this.assertCanCreateEvent(actor.userId);

    return this.tenant.runCreatingEvent(async (tx, setTenant) => {
      // `event` is not RLS-scoped, so it is inserted before the tenant is set.
      const event = await tx.event.create({
        data: {
          name: input.name,
          slug: makeSlug(input.name),
          currency,
          targetAmount: input.targetAmount ?? null,
          eventDate: input.eventDate ?? null,
          timezone: input.timezone ?? 'Africa/Kampala',
          country: input.country ?? 'UG',
          ownerUserId: actor.userId,
        },
      });

      // From here on, scope the transaction to the new event so the member and
      // audit rows satisfy RLS WITH CHECK.
      await setTenant(event.id);

      await tx.eventMember.create({
        data: {
          eventId: event.id,
          userId: actor.userId,
          role: EventRole.OWNER,
          status: 'ACTIVE',
        },
      });

      await this.audit.write(tx, {
        eventId: event.id,
        actorUserId: actor.userId,
        action: 'event:create',
        resourceType: 'event',
        resourceId: event.id,
        newValue: {
          name: event.name,
          currency: event.currency,
          targetAmount: event.targetAmount ? moneyToString(event.targetAmount) : null,
        },
      });

      return this.toSummary(event);
    });
  }

  /**
   * Enforce the active-event ceiling for the owner's plan (metering §10). Free
   * = 1 active event; an account subscription raises it (Organizer Pro → 5,
   * Business → unlimited). CLOSED/ARCHIVED events don't count, so finishing one
   * frees the slot. Blocks the "spin up unlimited free events" farming vector.
   */
  private async assertCanCreateEvent(userId: string): Promise<void> {
    const max = await this.maxActiveEvents(userId);
    if (max === null) return; // unlimited (Business)
    const active = await this.prisma.event.count({
      where: {
        ownerUserId: userId,
        status: { in: [EventStatus.DRAFT, EventStatus.ACTIVE, EventStatus.PAUSED] },
      },
    });
    if (active >= max) {
      throw new ForbiddenException(
        max === 1
          ? 'Your free plan covers 1 active event. Close it, upgrade it to a paid pack, or subscribe to run another.'
          : `Your plan covers ${max} active events. Close one or upgrade to run more.`,
      );
    }
  }

  /** The owner's active-event ceiling: subscription raises it above the free 1. */
  private async maxActiveEvents(userId: string): Promise<number | null> {
    const grant = await this.prisma.entitlementGrant.findFirst({
      where: {
        account: { ownerUserId: userId },
        status: { in: ['TRIALING', 'ACTIVE'] },
        plan: { isSubscription: true },
      },
      orderBy: { plan: { priceMinor: 'desc' } },
      select: { plan: { select: { code: true } } },
    });
    if (!grant) return 1; // free / per-event tier: one active event
    return grant.plan.code === 'BUSINESS' ? null : 5; // Business unlimited; Pro → 5
  }

  /** Read the event's own record (metadata, not amounts). */
  async getEvent(ctx: OperationContext): Promise<EventSummary> {
    this.permissions.assert(ctx.event.role, 'event:read');
    const event = await this.prisma.event.findUnique({ where: { id: ctx.event.eventId } });
    if (!event) throw new NotFoundException('Event not found');
    return this.toSummary(event);
  }

  /** Update event metadata (name / target / date). Requires `event:update`. */
  async updateEvent(ctx: OperationContext, input: UpdateEventInput): Promise<EventSummary> {
    this.permissions.assert(ctx.event.role, 'event:update');
    assertEventWritable(ctx.event.status);

    const before = await this.prisma.event.findUnique({ where: { id: ctx.event.eventId } });
    if (!before) throw new NotFoundException('Event not found');

    const data: Prisma.EventUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.targetAmount !== undefined) data.targetAmount = input.targetAmount;
    if (input.eventDate !== undefined) data.eventDate = input.eventDate;

    const updated = await this.prisma.event.update({ where: { id: ctx.event.eventId }, data });

    await this.tenant.runInEvent(ctx.event.eventId, (tx) =>
      this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'event:update',
        resourceType: 'event',
        resourceId: ctx.event.eventId,
        oldValue: {
          name: before.name,
          targetAmount: before.targetAmount ? moneyToString(before.targetAmount) : null,
          eventDate: before.eventDate?.toISOString() ?? null,
        },
        newValue: {
          name: updated.name,
          targetAmount: updated.targetAmount ? moneyToString(updated.targetAmount) : null,
          eventDate: updated.eventDate?.toISOString() ?? null,
        },
      }),
    );

    return this.toSummary(updated);
  }

  /**
   * Move the event through its lifecycle (§12, §33) — e.g. "the wedding is
   * over" → CLOSED, which makes the ledger read-only. Reopening a closed event
   * is permitted (authorized corrections) and is itself audited, so a
   * post-closure change is never silent.
   */
  async setStatus(ctx: OperationContext, status: EventStatus): Promise<EventSummary> {
    this.permissions.assert(ctx.event.role, 'event:update');

    const before = await this.prisma.event.findUnique({ where: { id: ctx.event.eventId } });
    if (!before) throw new NotFoundException('Event not found');

    const updated = await this.prisma.event.update({
      where: { id: ctx.event.eventId },
      data: { status },
    });

    await this.tenant.runInEvent(ctx.event.eventId, (tx) =>
      this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'event:set_status',
        resourceType: 'event',
        resourceId: ctx.event.eventId,
        oldValue: { status: before.status },
        newValue: { status },
      }),
    );

    return this.toSummary(updated);
  }

  /**
   * Every event this user is an ACTIVE member of ("My Events", §26).
   *
   * This is a CROSS-EVENT read, so it cannot run under the single-event tenant
   * GUC. It runs under `runAsUser`, which lets the `event_member` policy return
   * this user's own membership rows across every event (reads only).
   */
  async listMyEvents(actor: Actor): Promise<EventSummary[]> {
    const memberships = await this.tenant.runAsUser(actor.userId, (tx) =>
      tx.eventMember.findMany({
        where: { userId: actor.userId, status: 'ACTIVE' },
        select: { event: true },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return memberships.map((m) => this.toSummary(m.event));
  }

  private toSummary(e: {
    id: string;
    name: string;
    slug: string;
    status: EventStatus;
    currency: string;
    targetAmount: bigint | null;
    eventDate: Date | null;
    timezone: string;
    country: string;
    ownerUserId: string;
  }): EventSummary {
    return {
      id: e.id,
      name: e.name,
      slug: e.slug,
      status: e.status,
      currency: e.currency,
      targetAmount: e.targetAmount === null ? null : moneyToString(e.targetAmount),
      eventDate: e.eventDate?.toISOString() ?? null,
      timezone: e.timezone,
      country: e.country,
      ownerUserId: e.ownerUserId,
    };
  }
}
