import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Actor } from '@akabbo/access';
import { BillingService } from '@akabbo/billing';
import { PAYMENT_PROVIDER, PaymentProvider } from '@akabbo/providers';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentActor } from '../auth/current-actor.decorator';
import { PurchaseEventPackDto, SubscribeDto } from './billing.dto';

/** Express request with the raw body (needed for webhook signature checks). */
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * Billing surface (metering doc §8). Authenticated endpoints let a user buy an
 * event pack or subscribe (a MoMo collection of OUR SaaS fee — never contributor
 * money). The webhook is UNAUTHENTICATED but signature-verified, and is the
 * source of truth for grants (§7.4) — the app never activates a plan from the
 * client.
 */
@Controller('billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(
    private readonly billing: BillingService,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
  ) {}

  /** The effective plan + limits + SMS balance for an event (metering §7.1). */
  @Get('events/:eventId/entitlement')
  @UseGuards(AuthGuard)
  async entitlement(@CurrentActor() _actor: Actor, @Param('eventId') eventId: string) {
    return this.billing.resolveEntitlement({ eventId });
  }

  /** Start buying a one-off event pack → returns the MoMo collection prompt. */
  @Post('events/:eventId/purchase')
  @UseGuards(AuthGuard)
  async purchase(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: PurchaseEventPackDto,
  ) {
    return this.billing.purchaseEventPack(
      actor.userId,
      eventId,
      dto.planCode,
      dto.phone,
      dto.channel ?? 'mobile_money',
    );
  }

  /** Start an account subscription → returns the MoMo collection prompt. */
  @Post('subscribe')
  @UseGuards(AuthGuard)
  async subscribe(@CurrentActor() actor: Actor, @Body() dto: SubscribeDto) {
    return this.billing.subscribe(
      actor.userId,
      dto.planCode,
      dto.phone,
      dto.channel ?? 'mobile_money',
    );
  }

  /**
   * Payment gateway webhook — always returns 200 OK to the gateway instantly.
   * Parses payload and applies grants idempotently on gateway transaction id.
   */
  @Post('webhook/muda')
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest,
    @Headers('x-muda-signature') signature?: string,
  ): Promise<{ ok: boolean }> {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const event = this.payments.verifyAndParseWebhook(raw, signature ?? '');
    if (!event) {
      this.logger.warn('Muda webhook payload could not be parsed (unrecognized shape)');
      return { ok: true };
    }
    // Confirmed real bug: this previously discarded the error with zero
    // logging — a genuine failure here (bad plan lookup, DB error) was
    // completely invisible, indistinguishable from "nothing happened".
    await this.billing.applyPaymentWebhook(event).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`applyPaymentWebhook failed for ref=${event.reference}: ${msg}`);
    });
    return { ok: true };
  }
}
