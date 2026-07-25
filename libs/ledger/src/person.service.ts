import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProvenanceSource } from '@prisma/client';
import {
  EntitlementService,
  OperationContext,
  PermissionService,
  assertEventWritable,
} from '@akabbo/access';
import { TenantContext } from './tenant-context.service';
import { AuditWriter } from './audit.writer';

export interface CreatePersonInput {
  displayName: string;
  phone?: string;
  /** Provenance of this record (§3.2). Defaults to human_typed (typed path);
   *  the AI capture path passes ai_from_chat. */
  source?: ProvenanceSource;
}

export interface PersonView {
  id: string;
  displayName: string;
  phone: string | null;
  source: ProvenanceSource;
  /** The hinge: the authenticated User this contributor is claimed by, if any. */
  userId: string | null;
}

/**
 * People (contributors) within an event. Every create passes BOTH gates —
 * permission (`person:write`) and entitlement (`add_contributor`, a Phase-5
 * contributor-limit hook that is stubbed-allow now) — then writes the row with
 * provenance and an audit event, atomically.
 */
@Injectable()
export class PersonService {
  constructor(
    private readonly tenant: TenantContext,
    private readonly permissions: PermissionService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditWriter,
  ) {}

  async createPerson(ctx: OperationContext, input: CreatePersonInput): Promise<PersonView> {
    // Gate 1: permission (authorization).
    this.permissions.assert(ctx.event.role, 'person:write');
    // Gate 3: event status — CLOSED/ARCHIVED are read-only (§33).
    assertEventWritable(ctx.event.status);
    // Gate 2: entitlement (plan/limits) — stubbed-allow in Phase 1.
    const ent = await this.entitlements.check({ eventId: ctx.event.eventId }, 'add_contributor');
    if (!ent.allowed) throw new ForbiddenException(ent.message ?? ent.reason ?? 'Not entitled');

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const source = input.source ?? ProvenanceSource.human_typed;
      const person = await tx.person.create({
        data: {
          eventId: ctx.event.eventId,
          displayName: input.displayName,
          phone: input.phone ?? null,
          source,
          createdById: ctx.actor.userId,
        },
        select: { id: true, displayName: true, phone: true, source: true, userId: true },
      });

      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'person:create',
        resourceType: 'person',
        resourceId: person.id,
        source,
        newValue: { displayName: person.displayName },
      });

      return person;
    });
  }

  /**
   * Attach/correct a contributor's phone number after the fact — e.g. "Jesse's
   * contact is 07…, make sure to save it" said as a follow-up, or a contributor
   * created without one earlier in the conversation. Low-risk (doesn't move
   * money or send anything by itself), so it executes immediately like a group
   * assignment rather than staging for confirmation. This is also what makes
   * SMS reminders actually reachable — without a phone on file, a contributor
   * is silently excluded from every reminder/announcement blast.
   */
  async updateContact(ctx: OperationContext, personId: string, phone: string): Promise<PersonView> {
    this.permissions.assert(ctx.event.role, 'person:write');
    assertEventWritable(ctx.event.status);

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const before = await tx.person.findFirst({
        where: { id: personId },
        select: { phone: true },
      });
      if (!before) throw new NotFoundException('Person not found in this event');

      const updated = await tx.person.update({
        where: { id: personId },
        data: { phone },
        select: { id: true, displayName: true, phone: true, source: true, userId: true },
      });

      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'person:update_contact',
        resourceType: 'person',
        resourceId: personId,
        source: ProvenanceSource.human_typed,
        oldValue: { phone: before.phone },
        newValue: { phone },
      });

      return updated;
    });
  }

  /** List contributors in the event (read gate). */
  async listPeople(ctx: OperationContext): Promise<PersonView[]> {
    this.permissions.assert(ctx.event.role, 'ledger:read_amounts');
    return this.tenant.runInEvent(ctx.event.eventId, (tx) =>
      tx.person.findMany({
        orderBy: { createdAt: 'asc' },
        select: { id: true, displayName: true, phone: true, source: true, userId: true },
      }),
    );
  }

  /**
   * THE LINKAGE (design review §0): link a contributor Person to an
   * authenticated User — the foundation for the future contributor experience,
   * WITHOUT creating a duplicate. Duplicate-safe on two fronts:
   *   • a person already linked to a different user is rejected;
   *   • the `@@unique([eventId, userId])` constraint rejects linking a user who
   *     is already linked to another person in this event (caught as 409).
   * Idempotent: re-linking the same user is a no-op.
   *
   * Phase 1.5a exposes this as an organizer action (`person:write`). The
   * self-service SMS-claim path reuses this exact core when the contributor
   * surface is built — it is deliberately NOT built now.
   */
  async linkPersonToUser(
    ctx: OperationContext,
    personId: string,
    userId: string,
  ): Promise<PersonView> {
    this.permissions.assert(ctx.event.role, 'person:write');
    assertEventWritable(ctx.event.status);

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const person = await tx.person.findFirst({
        where: { id: personId },
        select: { id: true, userId: true },
      });
      if (!person) throw new NotFoundException('Person not found in this event');
      if (person.userId && person.userId !== userId) {
        throw new ConflictException('This person is already linked to another account');
      }

      try {
        const updated = await tx.person.update({
          where: { id: personId },
          data: { userId },
          select: { id: true, displayName: true, phone: true, source: true, userId: true },
        });

        if (person.userId !== userId) {
          await this.audit.write(tx, {
            eventId: ctx.event.eventId,
            actorUserId: ctx.actor.userId,
            action: 'person:link_user',
            resourceType: 'person',
            resourceId: personId,
            oldValue: { userId: person.userId },
            newValue: { userId },
          });
        }
        return updated;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException(
            'That account is already linked to a different person in this event',
          );
        }
        throw err;
      }
    });
  }

  /**
   * Merge a DUPLICATE person into a canonical one ("John Kato and John K. are
   * the same person"). All financial history is PRESERVED by reassigning the
   * source's pledges (and their fulfillments, which cascade via pledge) and any
   * attached files to the target; the merge is audited on the target; then the
   * now-empty source row is removed. Never destroys contribution history — it
   * only re-parents it.
   */
  async mergePeople(
    ctx: OperationContext,
    sourceId: string,
    targetId: string,
  ): Promise<{ targetId: string; movedPledges: number }> {
    this.permissions.assert(ctx.event.role, 'person:merge');
    assertEventWritable(ctx.event.status);
    if (sourceId === targetId) {
      throw new ConflictException('Cannot merge a person into themselves');
    }

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const source = await tx.person.findFirst({
        where: { id: sourceId },
        select: { id: true, displayName: true, phone: true, userId: true },
      });
      const target = await tx.person.findFirst({
        where: { id: targetId },
        select: { id: true, displayName: true, userId: true },
      });
      if (!source || !target) throw new NotFoundException('Person not found in this event');
      if (source.userId && target.userId && source.userId !== target.userId) {
        throw new ConflictException(
          'Both records are linked to different accounts — resolve that before merging',
        );
      }

      // Free the source's unique (event,user) claim before moving it, so the
      // target can inherit it without violating the partial-unique constraint.
      if (source.userId) {
        await tx.person.update({ where: { id: sourceId }, data: { userId: null } });
      }

      const moved = await tx.pledge.updateMany({
        where: { personId: sourceId },
        data: { personId: targetId },
      });
      await tx.fileObject.updateMany({
        where: { personId: sourceId },
        data: { personId: targetId },
      });

      // Target inherits the source's phone/account if it had none.
      const inheritUserId = !target.userId && source.userId ? source.userId : undefined;
      if (inheritUserId) {
        await tx.person.update({ where: { id: targetId }, data: { userId: inheritUserId } });
      }

      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'person:merge',
        resourceType: 'person',
        resourceId: targetId,
        source: ProvenanceSource.manual_correction,
        oldValue: { mergedFrom: sourceId, mergedName: source.displayName },
        newValue: { canonical: targetId, movedPledges: moved.count },
      });

      await tx.person.delete({ where: { id: sourceId } });
      return { targetId, movedPledges: moved.count };
    });
  }
}
