import { Injectable, NotFoundException } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { OperationContext, PermissionService } from '@akabbo/access';
import { AuditWriter, TenantContext, TenantTx } from '@akabbo/ledger';

export interface PaymentInstructionView {
  id: string;
  method: PaymentMethod;
  label: string;
  details: string;
  displayOrder: number;
  isPublic: boolean;
}

export interface PaymentInstructionInput {
  method: PaymentMethod;
  label: string;
  details: string;
  displayOrder?: number;
  isPublic?: boolean;
}

/**
 * The organizer's OWN payment channels (transparency spec Part 18/19) — how a
 * contributor sends money DIRECTLY to them. Akabbo never holds funds; this is
 * coordination text, not verified account data and not payment processing.
 *
 * Changes affect the public "how to contribute" section, so each bumps the
 * event's `publicRevision`.
 */
@Injectable()
export class PaymentInstructionService {
  constructor(
    private readonly tenant: TenantContext,
    private readonly permissions: PermissionService,
    private readonly audit: AuditWriter,
  ) {}

  async create(
    ctx: OperationContext,
    input: PaymentInstructionInput,
  ): Promise<PaymentInstructionView> {
    this.permissions.assert(ctx.event.role, 'payment_instruction:write');
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const row = await tx.paymentInstruction.create({
        data: {
          eventId: ctx.event.eventId,
          method: input.method,
          label: input.label,
          details: input.details,
          displayOrder: input.displayOrder ?? 0,
          isPublic: input.isPublic ?? true,
          createdById: ctx.actor.userId,
        },
        select: this.select,
      });
      await this.bumpRevision(tx, ctx.event.eventId);
      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'payment_instruction:create',
        resourceType: 'payment_instruction',
        resourceId: row.id,
        newValue: { method: input.method, label: input.label },
      });
      return this.toView(row);
    });
  }

  async update(
    ctx: OperationContext,
    id: string,
    input: Partial<PaymentInstructionInput>,
  ): Promise<PaymentInstructionView> {
    this.permissions.assert(ctx.event.role, 'payment_instruction:write');
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const current = await tx.paymentInstruction.findFirst({
        where: { id },
        select: { id: true },
      });
      if (!current) throw new NotFoundException('Payment instruction not found in this event');
      const row = await tx.paymentInstruction.update({
        where: { id },
        data: {
          method: input.method,
          label: input.label,
          details: input.details,
          displayOrder: input.displayOrder,
          isPublic: input.isPublic,
        },
        select: this.select,
      });
      await this.bumpRevision(tx, ctx.event.eventId);
      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'payment_instruction:update',
        resourceType: 'payment_instruction',
        resourceId: id,
        newValue: { method: row.method, label: row.label, isPublic: row.isPublic },
      });
      return this.toView(row);
    });
  }

  async remove(ctx: OperationContext, id: string): Promise<{ id: string }> {
    this.permissions.assert(ctx.event.role, 'payment_instruction:write');
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const current = await tx.paymentInstruction.findFirst({
        where: { id },
        select: { id: true },
      });
      if (!current) throw new NotFoundException('Payment instruction not found in this event');
      await tx.paymentInstruction.delete({ where: { id } });
      await this.bumpRevision(tx, ctx.event.eventId);
      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'payment_instruction:delete',
        resourceType: 'payment_instruction',
        resourceId: id,
        oldValue: { id },
      });
      return { id };
    });
  }

  async list(ctx: OperationContext): Promise<PaymentInstructionView[]> {
    this.permissions.assert(ctx.event.role, 'payment_instruction:read');
    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const rows = await tx.paymentInstruction.findMany({
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
        select: this.select,
      });
      return rows.map((r) => this.toView(r));
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
    method: true,
    label: true,
    details: true,
    displayOrder: true,
    isPublic: true,
  } as const;

  private toView(r: {
    id: string;
    method: PaymentMethod;
    label: string;
    details: string;
    displayOrder: number;
    isPublic: boolean;
  }): PaymentInstructionView {
    return {
      id: r.id,
      method: r.method,
      label: r.label,
      details: r.details,
      displayOrder: r.displayOrder,
      isPublic: r.isPublic,
    };
  }
}
