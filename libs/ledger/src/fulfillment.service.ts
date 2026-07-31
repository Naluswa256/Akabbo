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
import { OutboxWriter } from './outbox.writer';
import { deriveStatus, outstanding } from './pledge-status';
import { moneyToString } from './money';
import { DuplicateSuspectedException } from './duplicate.exception';

/** Window in which an identical payment is treated as a suspected duplicate. */
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export interface RecordFulfillmentInput {
  pledgeId: string;
  value: bigint;
  kind?: FulfillmentKind;
  method?: PaymentMethod;
  /** Explicit currency (§9.4). Defaults UGX; set for diaspora USD/GBP/EUR. */
  currency?: string;
  note?: string;
  occurredAt?: Date;
  /** Retry-safe key: the same key never books the money twice (§25, §42). */
  idempotencyKey?: string;
  /** Set true to record a payment that looked like a duplicate. */
  confirmDuplicate?: boolean;
  /** Provenance (§3.2). Defaults human_typed; AI path passes ai_from_chat. */
  source?: ProvenanceSource;
}

export interface RecordDirectContributionInput {
  personId?: string;
  displayName?: string;
  phone?: string;
  value: bigint;
  kind?: FulfillmentKind;
  method?: PaymentMethod;
  note?: string;
  type?: PledgeType;
  /** What an ITEM/SERVICE contribution actually is ("2 goats") — mirrors
   *  Pledge.description for in-kind pledges (§9.3). */
  description?: string;
  idempotencyKey?: string;
  source?: ProvenanceSource;
}

export interface RecordPledgeWithPaymentInput {
  personId: string;
  /** The full promised amount, e.g. "pledged 1,000,000". */
  committedValue: bigint;
  /** What's already been paid toward it, e.g. "...has paid 200,000 so far".
   *  Omit or 0 for a plain pledge with no payment yet. */
  receivedNow?: bigint;
  type?: PledgeType;
  /** What an ITEM/SERVICE pledge actually is ("5 kg of meat") — mirrors
   *  Pledge.description for in-kind pledges (§9.3). */
  description?: string;
  method?: PaymentMethod;
  note?: string;
  idempotencyKey?: string;
  source?: ProvenanceSource;
}

export interface FulfillmentView {
  id: string;
  pledgeId: string;
  value: string;
  kind: FulfillmentKind;
  method: PaymentMethod;
  verificationStatus: VerificationStatus;
  /** Derived pledge state after this fulfillment. */
  pledgeStatus: PledgeStatus;
  outstanding: string;
  /** True when this replayed an existing record rather than creating one. */
  idempotentReplay?: boolean;
}

/**
 * Fulfillments — payments/deliveries that discharge a pledge (blueprint §3).
 * Recording one, recomputing the pledge's derived status, writing the audit
 * event, AND enqueuing the confirmation outbox row all happen in ONE
 * transaction (§8).
 *
 * Money-safety properties:
 *  • IDEMPOTENT — a client key makes a retry return the original record (§42).
 *  • DUPLICATE-AWARE — an identical payment moments later stops and asks (§25).
 *  • HONEST — `verificationStatus` is REPORTED; nothing here claims VERIFIED
 *    without external evidence (§14, §15).
 */
@Injectable()
export class FulfillmentService {
  constructor(
    private readonly tenant: TenantContext,
    private readonly permissions: PermissionService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async recordFulfillment(
    ctx: OperationContext,
    input: RecordFulfillmentInput,
  ): Promise<FulfillmentView> {
    this.permissions.assert(ctx.event.role, 'fulfillment:write');
    assertEventWritable(ctx.event.status);
    const ent = await this.entitlements.check({ eventId: ctx.event.eventId }, 'record_fulfillment');
    if (!ent.allowed) throw new ForbiddenException(ent.message ?? ent.reason ?? 'Not entitled');

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      // Idempotent replay: the same key returns the original record.
      const replay = await this.findByIdempotencyKey(tx, input.idempotencyKey);
      if (replay) return replay;

      const pledge = await tx.pledge.findFirst({
        where: { id: input.pledgeId },
        select: { id: true, committedValue: true, status: true },
      });
      if (!pledge) throw new NotFoundException('Pledge not found in this event');
      if (pledge.status === PledgeStatus.CANCELLED) {
        throw new ForbiddenException('Cannot fulfill a cancelled pledge');
      }

      if (!input.confirmDuplicate) {
        await this.assertNotDuplicate(tx, input.pledgeId, input.value);
      }

      await this.assertWithinCommitted(tx, input.pledgeId, pledge.committedValue, input.value);

      return this.writeFulfillment(tx, ctx, {
        pledgeId: input.pledgeId,
        committedValue: pledge.committedValue,
        value: input.value,
        kind: input.kind,
        method: input.method,
        currency: input.currency,
        note: input.note,
        occurredAt: input.occurredAt,
        idempotencyKey: input.idempotencyKey,
        source: input.source,
      });
    });
  }

  /**
   * A DIRECT contribution (§15): "Peter gave me 100k cash" with no prior
   * pledge. Rather than inventing a third concept, this creates the commitment
   * and discharges it in the same transaction — the record is a pledge that is
   * immediately FULFILLED with `outstanding = 0`. The organizer never has to
   * "record a pledge first" just to record money that already arrived.
   */
  async recordDirectContribution(
    ctx: OperationContext,
    input: RecordDirectContributionInput,
  ): Promise<FulfillmentView> {
    this.permissions.assert(ctx.event.role, 'fulfillment:write');
    assertEventWritable(ctx.event.status);
    const ent = await this.entitlements.check({ eventId: ctx.event.eventId }, 'record_fulfillment');
    if (!ent.allowed) throw new ForbiddenException(ent.message ?? ent.reason ?? 'Not entitled');

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const replay = await this.findByIdempotencyKey(tx, input.idempotencyKey);
      if (replay) return replay;

      let personId = input.personId;
      const source = input.source ?? ProvenanceSource.human_typed;
      if (!personId) {
        if (!input.displayName) throw new NotFoundException('Person or displayName required');
        const p = await tx.person.create({
          data: {
            eventId: ctx.event.eventId,
            displayName: input.displayName,
            phone: input.phone ?? null,
            source,
            createdById: ctx.actor.userId,
          },
          select: { id: true },
        });
        await this.audit.write(tx, {
          eventId: ctx.event.eventId,
          actorUserId: ctx.actor.userId,
          action: 'person:create',
          resourceType: 'person',
          resourceId: p.id,
          source,
          newValue: { displayName: input.displayName },
        });
        personId = p.id;
      } else {
        const person = await tx.person.findFirst({
          where: { id: personId },
          select: { id: true },
        });
        if (!person) throw new NotFoundException('Person not found in this event');
      }

      const pledge = await tx.pledge.create({
        data: {
          eventId: ctx.event.eventId,
          personId,
          type: input.type ?? PledgeType.CASH,
          committedValue: input.value,
          description: input.description ?? null,
          status: PledgeStatus.PLEDGED, // recomputed to FULFILLED below
          isDirect: true,
          source,
          createdById: ctx.actor.userId,
        },
        select: { id: true, committedValue: true },
      });

      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'pledge:create_direct',
        resourceType: 'pledge',
        resourceId: pledge.id,
        source,
        newValue: {
          personId: input.personId,
          committedValue: moneyToString(input.value),
          isDirect: true,
        },
      });

      return this.writeFulfillment(tx, ctx, {
        pledgeId: pledge.id,
        committedValue: pledge.committedValue,
        value: input.value,
        kind: input.kind,
        method: input.method,
        note: input.note,
        idempotencyKey: input.idempotencyKey,
        source,
      });
    });
  }

  /**
   * A pledge AND an initial payment against it, together, atomically — for
   * the extremely common single-utterance shape "X pledged 1M, has paid 200k
   * so far". This exists specifically to avoid a real duplication bug: write
   * tools are ALWAYS staged (never auto-committed), so if the AI instead
   * called record_pledge and record_payment as two separate staged actions in
   * the same turn, the payment's pledge-lookup would query the real `pledge`
   * table before the pledge confirmation had landed, find nothing, and fall
   * through to recordDirectContribution — creating a SECOND, disconnected
   * pledge instead of one pledge with a partial payment. Doing both writes in
   * one transaction removes the read-before-write race entirely: there is no
   * intermediate state where the pledge exists but isn't visible yet.
   */
  async recordPledgeWithPayment(
    ctx: OperationContext,
    input: RecordPledgeWithPaymentInput,
  ): Promise<FulfillmentView> {
    this.permissions.assert(ctx.event.role, 'pledge:write');
    assertEventWritable(ctx.event.status);
    const pledgeEnt = await this.entitlements.check({ eventId: ctx.event.eventId }, 'create_pledge');
    if (!pledgeEnt.allowed) {
      throw new ForbiddenException(pledgeEnt.message ?? pledgeEnt.reason ?? 'Not entitled');
    }

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const person = await tx.person.findFirst({
        where: { id: input.personId },
        select: { id: true },
      });
      if (!person) throw new NotFoundException('Person not found in this event');

      const receivedNow = input.receivedNow ?? 0n;
      if (receivedNow > input.committedValue) {
        throw new ForbiddenException(
          `Received amount (${moneyToString(receivedNow)}) can't exceed the pledge itself ` +
            `(${moneyToString(input.committedValue)}).`,
        );
      }

      const source = input.source ?? ProvenanceSource.human_typed;
      const pledge = await tx.pledge.create({
        data: {
          eventId: ctx.event.eventId,
          personId: input.personId,
          type: input.type ?? PledgeType.CASH,
          committedValue: input.committedValue,
          description: input.description ?? null,
          status: PledgeStatus.PLEDGED, // recomputed below once the payment (if any) lands
          source,
          createdById: ctx.actor.userId,
        },
        select: { id: true, committedValue: true },
      });

      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'pledge:create',
        resourceType: 'pledge',
        resourceId: pledge.id,
        source,
        newValue: { personId: input.personId, committedValue: moneyToString(pledge.committedValue) },
      });

      if (receivedNow <= 0n) {
        // Plain pledge, nothing paid yet — same shape callers already expect
        // from a fulfillment-less pledge (outstanding = the full amount).
        return {
          id: pledge.id,
          pledgeId: pledge.id,
          value: '0',
          kind: FulfillmentKind.PAYMENT,
          method: PaymentMethod.UNKNOWN,
          verificationStatus: VerificationStatus.REPORTED,
          pledgeStatus: PledgeStatus.PLEDGED,
          outstanding: moneyToString(pledge.committedValue),
        };
      }

      return this.writeFulfillment(tx, ctx, {
        pledgeId: pledge.id,
        committedValue: pledge.committedValue,
        value: receivedNow,
        method: input.method,
        note: input.note,
        idempotencyKey: input.idempotencyKey,
        source,
      });
    });
  }

  /**
   * Correct a recorded payment's value ("actually John paid 300k, not 500k").
   * The row is updated and the pledge status recomputed from the authoritative
   * sum; the change is audited old→new (manual_correction) so history is never
   * lost. The correction itself is a new audit row — the original figure stays
   * visible in the trail.
   */
  async correctValue(
    ctx: OperationContext,
    fulfillmentId: string,
    newValue: bigint,
  ): Promise<FulfillmentView> {
    this.permissions.assert(ctx.event.role, 'fulfillment:correct');
    assertEventWritable(ctx.event.status);

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const current = await tx.fulfillment.findFirst({
        where: { id: fulfillmentId },
        select: { id: true, pledgeId: true, value: true },
      });
      if (!current) throw new NotFoundException('Payment not found in this event');

      const pledgeBefore = await tx.pledge.findFirst({
        where: { id: current.pledgeId },
        select: { committedValue: true },
      });
      if (pledgeBefore) {
        // Bound check excludes THIS fulfillment's own current value from the
        // existing sum, since it's being replaced, not added on top of itself.
        await this.assertWithinCommitted(
          tx,
          current.pledgeId,
          pledgeBefore.committedValue,
          newValue,
          fulfillmentId,
        );
      }

      const updated = await tx.fulfillment.update({
        where: { id: fulfillmentId },
        data: { value: newValue },
        select: {
          id: true,
          pledgeId: true,
          value: true,
          kind: true,
          method: true,
          verificationStatus: true,
        },
      });

      // Recompute the pledge's derived status from the new authoritative sum.
      const pledge = await tx.pledge.findFirst({
        where: { id: current.pledgeId },
        select: { committedValue: true, status: true },
      });
      const agg = await tx.fulfillment.aggregate({
        where: { pledgeId: current.pledgeId },
        _sum: { value: true },
      });
      const committed = pledge?.committedValue ?? 0n;
      const totalFulfilled = agg._sum.value ?? 0n;
      const status = deriveStatus(
        committed,
        totalFulfilled,
        pledge?.status === PledgeStatus.CANCELLED,
      );
      await tx.pledge.update({ where: { id: current.pledgeId }, data: { status } });

      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'fulfillment:correct',
        resourceType: 'fulfillment',
        resourceId: fulfillmentId,
        source: ProvenanceSource.manual_correction,
        oldValue: { value: moneyToString(current.value) },
        newValue: { value: moneyToString(newValue), pledgeStatus: status },
      });

      return {
        id: updated.id,
        pledgeId: updated.pledgeId,
        value: moneyToString(updated.value),
        kind: updated.kind,
        method: updated.method,
        verificationStatus: updated.verificationStatus,
        pledgeStatus: status,
        outstanding: moneyToString(outstanding(committed, totalFulfilled)),
      };
    });
  }

  // --- internals -------------------------------------------------------------

  private async findByIdempotencyKey(
    tx: TenantTx,
    idempotencyKey?: string,
  ): Promise<FulfillmentView | null> {
    if (!idempotencyKey) return null;
    const existing = await tx.fulfillment.findFirst({
      where: { idempotencyKey },
      select: {
        id: true,
        pledgeId: true,
        value: true,
        kind: true,
        method: true,
        verificationStatus: true,
        pledge: { select: { committedValue: true, status: true } },
      },
    });
    if (!existing) return null;

    const agg = await tx.fulfillment.aggregate({
      where: { pledgeId: existing.pledgeId },
      _sum: { value: true },
    });
    return {
      id: existing.id,
      pledgeId: existing.pledgeId,
      value: moneyToString(existing.value),
      kind: existing.kind,
      method: existing.method,
      verificationStatus: existing.verificationStatus,
      pledgeStatus: existing.pledge.status,
      outstanding: moneyToString(outstanding(existing.pledge.committedValue, agg._sum.value ?? 0n)),
      idempotentReplay: true,
    };
  }

  private async assertNotDuplicate(tx: TenantTx, pledgeId: string, value: bigint): Promise<void> {
    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);
    const similar = await tx.fulfillment.findFirst({
      where: { pledgeId, value, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, value: true, createdAt: true },
    });
    if (similar) {
      throw new DuplicateSuspectedException(
        similar.id,
        moneyToString(similar.value),
        similar.createdAt.toISOString(),
      );
    }
  }

  /**
   * A pledge can never be fulfilled beyond what was committed — once fully
   * paid (outstanding = 0), no further split/payment can be added, and no
   * correction can push the total over the committed amount either.
   * `excludeFulfillmentId` is set when correcting an EXISTING fulfillment,
   * so its own prior value isn't double-counted against itself.
   */
  private async assertWithinCommitted(
    tx: TenantTx,
    pledgeId: string,
    committedValue: bigint,
    additionalValue: bigint,
    excludeFulfillmentId?: string,
  ): Promise<void> {
    const agg = await tx.fulfillment.aggregate({
      where: { pledgeId, ...(excludeFulfillmentId ? { id: { not: excludeFulfillmentId } } : {}) },
      _sum: { value: true },
    });
    const existing = agg._sum.value ?? 0n;
    const projected = existing + additionalValue;
    if (projected > committedValue) {
      const remaining = outstanding(committedValue, existing);
      throw new ForbiddenException(
        `This pledge is already fully accounted for beyond that: only ${moneyToString(remaining)} ` +
          `remains outstanding (committed ${moneyToString(committedValue)}, already recorded ` +
          `${moneyToString(existing)}). Correct the pledge amount first if it should be higher.`,
      );
    }
  }

  /** Shared write path: fulfillment + status recompute + audit + outbox. */
  private async writeFulfillment(
    tx: TenantTx,
    ctx: OperationContext,
    input: {
      pledgeId: string;
      committedValue: bigint;
      value: bigint;
      kind?: FulfillmentKind;
      method?: PaymentMethod;
      currency?: string;
      note?: string;
      occurredAt?: Date;
      idempotencyKey?: string;
      source?: ProvenanceSource;
    },
  ): Promise<FulfillmentView> {
    const source = input.source ?? ProvenanceSource.human_typed;
    const fulfillment = await tx.fulfillment.create({
      data: {
        eventId: ctx.event.eventId,
        pledgeId: input.pledgeId,
        kind: input.kind ?? FulfillmentKind.PAYMENT,
        value: input.value,
        currency: input.currency ?? 'UGX',
        method: input.method ?? PaymentMethod.UNKNOWN,
        // Never auto-VERIFIED: we only ever hold a report unless we have proof.
        verificationStatus: VerificationStatus.REPORTED,
        note: input.note ?? null,
        occurredAt: input.occurredAt ?? new Date(),
        idempotencyKey: input.idempotencyKey ?? null,
        source,
        createdById: ctx.actor.userId,
      },
      select: {
        id: true,
        pledgeId: true,
        value: true,
        kind: true,
        method: true,
        verificationStatus: true,
      },
    });

    // Recompute derived status from the authoritative sum (never trust a
    // running total carried in the app).
    const agg = await tx.fulfillment.aggregate({
      where: { pledgeId: input.pledgeId },
      _sum: { value: true },
    });
    const totalFulfilled = agg._sum.value ?? 0n;
    const status = deriveStatus(input.committedValue, totalFulfilled);
    const remaining = outstanding(input.committedValue, totalFulfilled);

    await tx.pledge.update({ where: { id: input.pledgeId }, data: { status } });

    await this.audit.write(tx, {
      eventId: ctx.event.eventId,
      actorUserId: ctx.actor.userId,
      action: 'fulfillment:create',
      resourceType: 'fulfillment',
      resourceId: fulfillment.id,
      source,
      newValue: {
        pledgeId: fulfillment.pledgeId,
        value: moneyToString(fulfillment.value),
        method: fulfillment.method,
        verificationStatus: fulfillment.verificationStatus,
        pledgeStatus: status,
      },
    });

    // Outbox: a confirmation is due to the contributor. Keyed on the
    // fulfillment id so the eventual send is idempotent (§3.5).
    await this.outbox.enqueue(tx, {
      eventId: ctx.event.eventId,
      topic: 'contribution.recorded',
      idempotencyKey: `fulfillment:${fulfillment.id}`,
      payload: {
        fulfillmentId: fulfillment.id,
        pledgeId: fulfillment.pledgeId,
        value: moneyToString(fulfillment.value),
      },
    });

    return {
      id: fulfillment.id,
      pledgeId: fulfillment.pledgeId,
      value: moneyToString(fulfillment.value),
      kind: fulfillment.kind,
      method: fulfillment.method,
      verificationStatus: fulfillment.verificationStatus,
      pledgeStatus: status,
      outstanding: moneyToString(remaining),
    };
  }
}
