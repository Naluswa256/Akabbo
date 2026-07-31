import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  FulfillmentKind,
  PaymentMethod,
  PledgeStatus,
  PledgeType,
  ProvenanceSource,
  VerificationStatus,
} from '@prisma/client';
import {
  EntitlementService,
  OperationContext,
  PermissionService,
  assertEventWritable,
} from '@akabbo/access';
import { TenantContext, TenantTx } from './tenant-context.service';
import { AuditWriter } from './audit.writer';
import { deriveStatus, outstanding } from './pledge-status';
import { moneyToString } from './money';

export interface CreatePledgeInput {
  personId: string;
  committedValue: bigint;
  type?: PledgeType;
  targetBudgetItemId?: string;
  /** IN-KIND detail (§9.3): "100 white plastic chairs". Optional; goods keep a
   *  0 committedValue and are described here — we never invent a money value. */
  description?: string;
  quantity?: number;
  unit?: string;
  estimatedValue?: bigint;
  /** Provenance (§3.2). Defaults human_typed; AI path passes ai_from_chat. */
  source?: ProvenanceSource;
}

export interface PledgeView {
  id: string;
  personId: string;
  type: PledgeType;
  committedValue: string;
  status: PledgeStatus;
  source: ProvenanceSource;
}

/** One split (partial payment) recorded against a pledge. */
export interface PledgeSplitView {
  id: string;
  value: string;
  kind: FulfillmentKind;
  method: PaymentMethod;
  verificationStatus: VerificationStatus;
  note: string | null;
  occurredAt: Date;
}

/** A pledge plus its person and every split recorded against it — the shape
 *  the manual contributions/pledges edit panel lists and edits. */
export interface PledgeWithSplitsView extends PledgeView {
  personName: string;
  personPhone: string | null;
  outstanding: string;
  fulfillments: PledgeSplitView[];
  /** In-kind detail (§9.3) — set when `type` is ITEM/SERVICE ("2 goats").
   *  Always null for CASH. */
  description: string | null;
  quantity: number | null;
  unit: string | null;
  estimatedValue: string | null;
  /** Budget line this pledge is earmarked to cover, if any — null means it's
   *  outside the planned budget (a perfectly normal, valid state). */
  targetBudgetItemId: string | null;
  targetBudgetItemName: string | null;
}

/**
 * Pledges — the commitment atom (blueprint §3). Create passes both gates and
 * stamps provenance; corrections NEVER destroy history — they update the
 * current value and append a `manual_correction` audit row (§3.3). Status is
 * always derived from the numbers, never set directly.
 */
@Injectable()
export class PledgeService {
  constructor(
    private readonly tenant: TenantContext,
    private readonly permissions: PermissionService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditWriter,
  ) {}

  async createPledge(ctx: OperationContext, input: CreatePledgeInput): Promise<PledgeView> {
    this.permissions.assert(ctx.event.role, 'pledge:write');
    assertEventWritable(ctx.event.status);
    const ent = await this.entitlements.check({ eventId: ctx.event.eventId }, 'create_pledge');
    if (!ent.allowed) throw new ForbiddenException(ent.message ?? ent.reason ?? 'Not entitled');

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      // Person must belong to this event (RLS already guarantees the scope).
      const person = await tx.person.findFirst({
        where: { id: input.personId },
        select: { id: true },
      });
      if (!person) throw new NotFoundException('Person not found in this event');

      const source = input.source ?? ProvenanceSource.human_typed;
      const pledge = await tx.pledge.create({
        data: {
          eventId: ctx.event.eventId,
          personId: input.personId,
          type: input.type ?? PledgeType.CASH,
          committedValue: input.committedValue,
          targetBudgetItemId: input.targetBudgetItemId ?? null,
          description: input.description ?? null,
          quantity: input.quantity ?? null,
          unit: input.unit ?? null,
          estimatedValue: input.estimatedValue ?? null,
          status: PledgeStatus.PLEDGED,
          source,
          createdById: ctx.actor.userId,
        },
        select: {
          id: true,
          personId: true,
          type: true,
          committedValue: true,
          status: true,
          source: true,
        },
      });

      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'pledge:create',
        resourceType: 'pledge',
        resourceId: pledge.id,
        source,
        newValue: {
          personId: pledge.personId,
          committedValue: moneyToString(pledge.committedValue),
          type: pledge.type,
        },
      });

      return this.toView(pledge);
    });
  }

  /**
   * Correct a pledge's committed value. History is preserved: the current value
   * is updated and a `manual_correction` audit event records old → new.
   */
  async correctCommittedValue(
    ctx: OperationContext,
    pledgeId: string,
    newValue: bigint,
  ): Promise<PledgeView> {
    this.permissions.assert(ctx.event.role, 'fulfillment:correct');
    assertEventWritable(ctx.event.status);

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const current = await tx.pledge.findFirst({
        where: { id: pledgeId },
        select: { id: true, committedValue: true, status: true },
      });
      if (!current) throw new NotFoundException('Pledge not found in this event');

      const totalFulfilled = await this.sumFulfillments(tx, pledgeId);
      const status = deriveStatus(
        newValue,
        totalFulfilled,
        current.status === PledgeStatus.CANCELLED,
      );

      const updated = await tx.pledge.update({
        where: { id: pledgeId },
        data: { committedValue: newValue, status },
        select: {
          id: true,
          personId: true,
          type: true,
          committedValue: true,
          status: true,
          source: true,
        },
      });

      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'pledge:correct',
        resourceType: 'pledge',
        resourceId: pledgeId,
        source: ProvenanceSource.manual_correction,
        oldValue: { committedValue: moneyToString(current.committedValue) },
        newValue: { committedValue: moneyToString(newValue) },
      });

      return this.toView(updated);
    });
  }

  /**
   * List every pledge with its person and full split history, for the manual
   * edit panel (list contributions/pledges, add/edit splits until fulfilled).
   */
  async listPledges(ctx: OperationContext, personId?: string): Promise<PledgeWithSplitsView[]> {
    this.permissions.assert(ctx.event.role, 'ledger:read_amounts');

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const pledges = await tx.pledge.findMany({
        where: personId ? { personId } : undefined,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          personId: true,
          type: true,
          committedValue: true,
          status: true,
          source: true,
          description: true,
          quantity: true,
          unit: true,
          estimatedValue: true,
          targetBudgetItemId: true,
          budgetItem: { select: { name: true } },
          person: { select: { displayName: true, phone: true } },
          fulfillments: {
            orderBy: { occurredAt: 'asc' },
            select: {
              id: true,
              value: true,
              kind: true,
              method: true,
              verificationStatus: true,
              note: true,
              occurredAt: true,
            },
          },
        },
      });

      return pledges.map((p) => {
        const totalFulfilled = p.fulfillments.reduce((sum, f) => sum + f.value, 0n);
        return {
          id: p.id,
          personId: p.personId,
          personName: p.person.displayName,
          personPhone: p.person.phone,
          type: p.type,
          committedValue: moneyToString(p.committedValue),
          status: p.status,
          source: p.source,
          outstanding: moneyToString(outstanding(p.committedValue, totalFulfilled)),
          description: p.description,
          quantity: p.quantity,
          unit: p.unit,
          estimatedValue: p.estimatedValue === null ? null : moneyToString(p.estimatedValue),
          targetBudgetItemId: p.targetBudgetItemId,
          targetBudgetItemName: p.budgetItem?.name ?? null,
          fulfillments: p.fulfillments.map((f) => ({
            id: f.id,
            value: moneyToString(f.value),
            kind: f.kind,
            method: f.method,
            verificationStatus: f.verificationStatus,
            note: f.note,
            occurredAt: f.occurredAt,
          })),
        };
      });
    });
  }

  async cancelPledge(ctx: OperationContext, pledgeId: string): Promise<PledgeView> {
    this.permissions.assert(ctx.event.role, 'pledge:cancel');
    assertEventWritable(ctx.event.status);

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const current = await tx.pledge.findFirst({
        where: { id: pledgeId },
        select: { id: true, status: true },
      });
      if (!current) throw new NotFoundException('Pledge not found in this event');

      const updated = await tx.pledge.update({
        where: { id: pledgeId },
        data: { status: PledgeStatus.CANCELLED },
        select: {
          id: true,
          personId: true,
          type: true,
          committedValue: true,
          status: true,
          source: true,
        },
      });

      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'pledge:cancel',
        resourceType: 'pledge',
        resourceId: pledgeId,
        oldValue: { status: current.status },
        newValue: { status: PledgeStatus.CANCELLED },
      });

      return this.toView(updated);
    });
  }

  private async sumFulfillments(tx: TenantTx, pledgeId: string): Promise<bigint> {
    const agg = await tx.fulfillment.aggregate({
      where: { pledgeId },
      _sum: { value: true },
    });
    return agg._sum.value ?? 0n;
  }

  private toView(p: {
    id: string;
    personId: string;
    type: PledgeType;
    committedValue: bigint;
    status: PledgeStatus;
    source: ProvenanceSource;
  }): PledgeView {
    return {
      id: p.id,
      personId: p.personId,
      type: p.type,
      committedValue: moneyToString(p.committedValue),
      status: p.status,
      source: p.source,
    };
  }
}
