import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Actor, OperationContext } from '@akabbo/access';
import { MembershipService } from '@akabbo/ledger';
import {
  AnnouncementService,
  PaymentInstructionService,
  PublicSettingsService,
} from '@akabbo/transparency';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentActor } from '../auth/current-actor.decorator';
import {
  CreateAnnouncementDto,
  CreatePaymentInstructionDto,
  UpdatePaymentInstructionDto,
  UpdatePublicSettingsDto,
} from './transparency.dto';

/**
 * ORGANIZER-side management of the public transparency layer (transparency spec
 * Part 15/16/17/18). Authenticated + permission-gated inside the services —
 * this is the private control plane for what the public link shows. The public
 * READ surface is a separate, unauthenticated controller.
 */
@Controller('events/:eventId')
@UseGuards(AuthGuard)
export class TransparencyController {
  constructor(
    private readonly membership: MembershipService,
    private readonly settings: PublicSettingsService,
    private readonly announcements: AnnouncementService,
    private readonly paymentInstructions: PaymentInstructionService,
  ) {}

  private ctx(actor: Actor, eventId: string): Promise<OperationContext> {
    return this.membership.requireContext(actor, eventId).then((event) => ({ actor, event }));
  }

  // --- Public settings -------------------------------------------------------
  @Get('public/settings')
  async getSettings(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.settings.getSettings(await this.ctx(actor, eventId));
  }

  @Patch('public/settings')
  async updateSettings(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: UpdatePublicSettingsDto,
  ) {
    return this.settings.updateSettings(await this.ctx(actor, eventId), dto);
  }

  @Post('public/token/rotate')
  async rotateToken(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.settings.rotateAccessToken(await this.ctx(actor, eventId));
  }

  @Delete('public/token')
  async clearToken(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.settings.clearAccessToken(await this.ctx(actor, eventId));
  }

  // --- Announcements ---------------------------------------------------------
  @Get('announcements')
  async listAnnouncements(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.announcements.list(await this.ctx(actor, eventId));
  }

  @Post('announcements')
  async createAnnouncement(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: CreateAnnouncementDto,
  ) {
    return this.announcements.create(await this.ctx(actor, eventId), dto.body);
  }

  @Post('announcements/:id/publish')
  async publishAnnouncement(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Param('id') id: string,
  ) {
    return this.announcements.publish(await this.ctx(actor, eventId), id);
  }

  @Post('announcements/:id/archive')
  async archiveAnnouncement(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Param('id') id: string,
  ) {
    return this.announcements.archive(await this.ctx(actor, eventId), id);
  }

  // --- Payment instructions --------------------------------------------------
  @Get('payment-instructions')
  async listInstructions(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.paymentInstructions.list(await this.ctx(actor, eventId));
  }

  @Post('payment-instructions')
  async createInstruction(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: CreatePaymentInstructionDto,
  ) {
    return this.paymentInstructions.create(await this.ctx(actor, eventId), dto);
  }

  @Patch('payment-instructions/:id')
  async updateInstruction(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @Body() dto: UpdatePaymentInstructionDto,
  ) {
    return this.paymentInstructions.update(await this.ctx(actor, eventId), id, dto);
  }

  @Delete('payment-instructions/:id')
  async deleteInstruction(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Param('id') id: string,
  ) {
    return this.paymentInstructions.remove(await this.ctx(actor, eventId), id);
  }
}
