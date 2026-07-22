import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { GroupKind } from '@prisma/client';
import { OperationContext, PermissionService, assertEventWritable } from '@akabbo/access';
import { TenantContext } from './tenant-context.service';
import { AuditWriter } from './audit.writer';
import { moneyToString } from './money';

export interface GroupView {
  id: string;
  name: string;
  kind: GroupKind;
  memberCount: number;
}

export interface GroupContribution {
  groupId: string;
  name: string;
  kind: GroupKind;
  memberCount: number;
  committed: string;
  received: string;
  outstanding: string;
}

/**
 * Contributor groups / family sides (next-increment §9). A generic, event-scoped
 * grouping used for reporting, filtering and reminder targeting. Groups and
 * memberships are created ONLY from explicit input — never inferred (§9). Both
 * writes are audited; reads roll up contribution totals per group.
 */
@Injectable()
export class GroupService {
  constructor(
    private readonly tenant: TenantContext,
    private readonly permissions: PermissionService,
    private readonly audit: AuditWriter,
  ) {}

  async createGroup(
    ctx: OperationContext,
    name: string,
    kind: GroupKind = GroupKind.OTHER,
  ): Promise<GroupView> {
    this.permissions.assert(ctx.event.role, 'group:write');
    assertEventWritable(ctx.event.status);
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const group = await tx.contributorGroup.create({
        data: { eventId: ctx.event.eventId, name, kind, createdById: ctx.actor.userId },
        select: { id: true, name: true, kind: true },
      });
      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'group:create',
        resourceType: 'contributor_group',
        resourceId: group.id,
        newValue: { name, kind },
      });
      return { ...group, memberCount: 0 };
    });
  }

  /** Add a person to a group (idempotent on the (person, group) pair). */
  async assignPerson(
    ctx: OperationContext,
    personId: string,
    groupId: string,
    role?: string,
  ): Promise<{ personId: string; groupId: string }> {
    this.permissions.assert(ctx.event.role, 'group:write');
    assertEventWritable(ctx.event.status);
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const [person, group] = await Promise.all([
        tx.person.findFirst({ where: { id: personId }, select: { id: true } }),
        tx.contributorGroup.findFirst({ where: { id: groupId }, select: { id: true } }),
      ]);
      if (!person) throw new NotFoundException('Person not found in this event');
      if (!group) throw new NotFoundException('Group not found in this event');

      try {
        await tx.personGroup.create({
          data: { eventId: ctx.event.eventId, personId, groupId, role: role ?? null },
          select: { id: true },
        });
      } catch (err) {
        // Already a member → treat as success (idempotent).
        if (!(err instanceof ConflictException) && !isUniqueViolation(err)) throw err;
      }
      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'group:assign',
        resourceType: 'person_group',
        resourceId: personId,
        newValue: { personId, groupId, role: role ?? null },
      });
      return { personId, groupId };
    });
  }

  async listGroups(ctx: OperationContext): Promise<GroupView[]> {
    this.permissions.assert(ctx.event.role, 'group:read');
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const rows = await tx.contributorGroup.findMany({
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, kind: true, _count: { select: { members: true } } },
      });
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        memberCount: r._count.members,
      }));
    });
  }

  /**
   * Per-group contribution rollup ("how much has the bride's side contributed?").
   * Amounts require `ledger:read_amounts`; sums are computed in SQL.
   */
  async groupContributions(ctx: OperationContext): Promise<GroupContribution[]> {
    this.permissions.assert(ctx.event.role, 'ledger:read_amounts');
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          group_id: string;
          name: string;
          kind: GroupKind;
          members: bigint;
          committed: bigint;
          received: bigint;
        }[]
      >`
        SELECT g.id AS group_id, g.name, g.kind,
               (SELECT COUNT(*) FROM person_group pg WHERE pg.group_id = g.id)::bigint AS members,
               COALESCE((SELECT SUM(pl.committed_value) FROM pledge pl
                          JOIN person_group pg2 ON pg2.person_id = pl.person_id
                          WHERE pg2.group_id = g.id AND pl.status <> 'CANCELLED'), 0)::bigint AS committed,
               COALESCE((SELECT SUM(f.value) FROM fulfillment f
                          JOIN pledge pl2 ON f.pledge_id = pl2.id
                          JOIN person_group pg3 ON pg3.person_id = pl2.person_id
                          WHERE pg3.group_id = g.id AND pl2.status <> 'CANCELLED'), 0)::bigint AS received
        FROM contributor_group g
        ORDER BY received DESC
      `;
      return rows.map((r) => {
        const committed = r.committed;
        const received = r.received;
        const outstanding = committed > received ? committed - received : 0n;
        return {
          groupId: r.group_id,
          name: r.name,
          kind: r.kind,
          memberCount: Number(r.members),
          committed: moneyToString(committed),
          received: moneyToString(received),
          outstanding: moneyToString(outstanding),
        };
      });
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'P2002'
  );
}
