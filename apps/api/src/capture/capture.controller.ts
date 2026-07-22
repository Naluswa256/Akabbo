import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Actor, OperationContext } from '@akabbo/access';
import { MembershipService } from '@akabbo/ledger';
import { AssistantService, CaptureService, ConfirmationService } from '@akabbo/ai';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentActor } from '../auth/current-actor.decorator';
import { AssistantDto, CaptureDto } from './capture.dto';

/**
 * The conversational capture surface (Phase 2). `capture` turns natural
 * language into a ledger action via the same domain services the typed API
 * uses — both gates enforced inside them. Low-confidence writes return a
 * pending confirmation the user resolves via confirm/reject.
 */
@Controller('events/:eventId')
@UseGuards(AuthGuard)
export class CaptureController {
  constructor(
    private readonly membership: MembershipService,
    private readonly capture: CaptureService,
    private readonly assistant: AssistantService,
    private readonly confirmations: ConfirmationService,
  ) {}

  private ctx(actor: Actor, eventId: string): Promise<OperationContext> {
    return this.membership.requireContext(actor, eventId).then((event) => ({ actor, event }));
  }

  @Post('capture')
  async captureUtterance(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: CaptureDto,
  ) {
    return this.capture.capture(await this.ctx(actor, eventId), dto.utterance);
  }

  /**
   * The AI operating interface (product spec Part 1/2) — one conversational turn
   * that both answers and acts through controlled tools. Writes it proposes are
   * staged as pending confirmations (returned in `staged`) for the organizer to
   * confirm via the pending endpoints below.
   */
  @Post('assistant')
  async assistantChat(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: AssistantDto,
  ) {
    return this.assistant.chat(await this.ctx(actor, eventId), dto.message);
  }

  @Get('pending')
  async listPending(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.confirmations.listPending(await this.ctx(actor, eventId));
  }

  @Post('pending/:id/confirm')
  async confirm(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Param('id') id: string,
  ) {
    return this.confirmations.confirm(await this.ctx(actor, eventId), id);
  }

  @Post('pending/:id/reject')
  async reject(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Param('id') id: string,
  ) {
    return this.confirmations.reject(await this.ctx(actor, eventId), id);
  }
}
