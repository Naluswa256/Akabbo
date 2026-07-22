import { Injectable, NotFoundException } from '@nestjs/common';
import { AnnouncementStatus, ProvenanceSource } from '@prisma/client';
import { OperationContext, PermissionService } from '@akabbo/access';
import { AuditWriter, TenantContext, TenantTx } from '@akabbo/ledger';

export interface AnnouncementView {
  id: string;
  body: string;
  status: AnnouncementStatus;
  source: ProvenanceSource;
  publishedAt: string | null;
  createdAt: string;
}

/**
 * Public event announcements (transparency spec Part 17). An organizer — often
 * via the AI, which DRAFTS text a human then approves — creates a DRAFT, then
 * PUBLISHES it. Only PUBLISHED rows reach the public projection. The body is
 * approved human-facing text, never executed as an instruction (§10).
 *
 * Publishing/archiving changes what the public sees, so both bump the event's
 * `publicRevision` (cache invalidation, Part 12).
 */
@Injectable()
export class AnnouncementService {
  constructor(
    private readonly tenant: TenantContext,
    private readonly permissions: PermissionService,
    private readonly audit: AuditWriter,
  ) {}

  async create(
    ctx: OperationContext,
    body: string,
    source: ProvenanceSource = ProvenanceSource.human_typed,
  ): Promise<AnnouncementView> {
    this.permissions.assert(ctx.event.role, 'announcement:write');
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const a = await tx.eventAnnouncement.create({
        data: {
          eventId: ctx.event.eventId,
          body,
          status: AnnouncementStatus.DRAFT,
          source,
          createdById: ctx.actor.userId,
        },
        select: this.select,
      });
      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'announcement:create',
        resourceType: 'event_announcement',
        resourceId: a.id,
        source,
        newValue: { body },
      });
      return this.toView(a);
    });
  }

  async publish(ctx: OperationContext, id: string): Promise<AnnouncementView> {
    return this.transition(ctx, id, AnnouncementStatus.PUBLISHED, 'announcement:publish');
  }

  async archive(ctx: OperationContext, id: string): Promise<AnnouncementView> {
    return this.transition(ctx, id, AnnouncementStatus.ARCHIVED, 'announcement:archive');
  }

  async list(ctx: OperationContext): Promise<AnnouncementView[]> {
    this.permissions.assert(ctx.event.role, 'announcement:read');
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const rows = await tx.eventAnnouncement.findMany({
        orderBy: { createdAt: 'desc' },
        select: this.select,
      });
      return rows.map((r) => this.toView(r));
    });
  }

  private async transition(
    ctx: OperationContext,
    id: string,
    status: AnnouncementStatus,
    action: string,
  ): Promise<AnnouncementView> {
    this.permissions.assert(ctx.event.role, 'announcement:write');
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const current = await tx.eventAnnouncement.findFirst({
        where: { id },
        select: { id: true, status: true },
      });
      if (!current) throw new NotFoundException('Announcement not found in this event');

      const a = await tx.eventAnnouncement.update({
        where: { id },
        data: {
          status,
          publishedAt: status === AnnouncementStatus.PUBLISHED ? new Date() : undefined,
        },
        select: this.select,
      });
      await this.bumpRevision(tx, ctx.event.eventId);
      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action,
        resourceType: 'event_announcement',
        resourceId: id,
        oldValue: { status: current.status },
        newValue: { status },
      });
      return this.toView(a);
    });
  }

  private bumpRevision(tx: TenantTx, eventId: string): Promise<unknown> {
    return tx.event.update({
      where: { id: eventId },
      data: { publicRevision: { increment: 1 } },
      select: { id: true },
    });
  }

  private readonly select = {
    id: true,
    body: true,
    status: true,
    source: true,
    publishedAt: true,
    createdAt: true,
  } as const;

  private toView(a: {
    id: string;
    body: string;
    status: AnnouncementStatus;
    source: ProvenanceSource;
    publishedAt: Date | null;
    createdAt: Date;
  }): AnnouncementView {
    return {
      id: a.id,
      body: a.body,
      status: a.status,
      source: a.source,
      publishedAt: a.publishedAt ? a.publishedAt.toISOString() : null,
      createdAt: a.createdAt.toISOString(),
    };
  }
}
