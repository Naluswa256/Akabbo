import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Actor, OperationContext } from '@akabbo/access';
import { MembershipService } from '@akabbo/ledger';
import { SmsService } from '@akabbo/comms';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentActor } from '../auth/current-actor.decorator';
import { SendSmsDto } from './sms.dto';

/**
 * Communications surface (blueprint §2.4). Sending spends SMS credits (reserve →
 * commit/refund on the worker) and is permission-gated; delivery endpoints answer
 * "who received / who didn't" (§34).
 */
@Controller('events/:eventId/sms')
@UseGuards(AuthGuard)
export class SmsController {
  constructor(
    private readonly membership: MembershipService,
    private readonly sms: SmsService,
  ) {}

  private ctx(actor: Actor, eventId: string): Promise<OperationContext> {
    return this.membership.requireContext(actor, eventId).then((event) => ({ actor, event }));
  }

  /** Who's outstanding + can we afford to remind them all? */
  @Get('preview')
  async preview(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.sms.previewReminders(await this.ctx(actor, eventId));
  }

  @Post('reminders')
  async reminders(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: SendSmsDto,
  ) {
    return this.sms.sendReminders(await this.ctx(actor, eventId), dto.body);
  }

  @Post('announcement')
  async announcement(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: SendSmsDto,
  ) {
    return this.sms.sendAnnouncement(await this.ctx(actor, eventId), dto.body);
  }

  @Get('campaigns')
  async campaigns(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.sms.listCampaigns(await this.ctx(actor, eventId));
  }

  @Get('delivery')
  async delivery(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Query('campaignId') campaignId?: string,
  ) {
    return this.sms.delivery(await this.ctx(actor, eventId), campaignId);
  }
}
