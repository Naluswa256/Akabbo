import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { InvoiceStatus } from '@prisma/client';
import { BillingService } from '@akabbo/billing';
import { ReconcileInvoiceDto } from './admin-billing.dto';

/**
 * Admin-only: see and manually resolve payments — the safety net for when
 * Muda shows a collection as successful but our webhook never applied it
 * (a real gap found investigating a live incident: the webhook silently
 * discarded errors, and its status-string match missed Muda's own
 * "SUCCESSFUL" wording — both fixed, this is the manual fallback for
 * whatever those fixes don't catch, or a genuinely lost webhook).
 *
 * Gated the same way every other admin surface in this app is (see
 * AdminController) — a shared secret header, not a JWT/role.
 */
@Controller('admin/invoices')
export class AdminBillingController {
  constructor(private readonly billing: BillingService) {}

  private assertAdminSecret(secretHeader?: string): void {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret) {
      throw new ForbiddenException('Admin surface is not configured (ADMIN_SECRET unset)');
    }
    if (!secretHeader || secretHeader !== adminSecret) {
      throw new ForbiddenException('Invalid admin secret key for admin surface');
    }
  }

  /** Every invoice, newest first — optionally `?status=PENDING` etc. */
  @Get()
  async list(
    @Headers('x-akabbo-admin-secret') secret: string | undefined,
    @Query('status') status?: InvoiceStatus,
  ) {
    this.assertAdminSecret(secret);
    const rows = await this.billing.listInvoices(status);
    return rows.map((r) => ({ ...r, amountMinor: r.amountMinor.toString() }));
  }

  /**
   * Mark an invoice paid after confirming success directly on the Muda
   * dashboard, and grant its entitlement — runs through the exact same
   * grant logic a real webhook does (idempotent, plan-driven), not a
   * shortcut that just flips a status column.
   */
  @Post(':id/reconcile')
  async reconcile(
    @Headers('x-akabbo-admin-secret') secret: string | undefined,
    @Param('id') id: string,
    @Body() dto: ReconcileInvoiceDto,
  ) {
    this.assertAdminSecret(secret);
    return this.billing.reconcileInvoice(id, dto.gatewayTransactionId);
  }
}
