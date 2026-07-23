import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Actor, OperationContext } from '@akabbo/access';
import { InvitationService, MembershipService } from '@akabbo/ledger';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentActor } from '../auth/current-actor.decorator';
import { CreateInvitationDto } from './invitation.dto';

/**
 * Invitation surface (blueprint §4–§5, §36). Onboarding a NON-user:
 *   1. a member creates an invitation → shareable token link
 *   2. the invitee opens it (PUBLIC view — no auth) to see event + role
 *   3. the invitee does OTP (existing /auth) → JWT
 *   4. the invitee POSTs accept with the token → membership created
 * The token is the capability; a leaked link is inert until OTP + accept.
 */
@Controller()
export class InvitationController {
  constructor(
    private readonly invitations: InvitationService,
    private readonly membership: MembershipService,
  ) {}

  private ctx(actor: Actor, eventId: string): Promise<OperationContext> {
    return this.membership.requireContext(actor, eventId).then((event) => ({ actor, event }));
  }

  // --- Public (no auth): the landing page ------------------------------------
  @Get('invitations/:token')
  viewByToken(@Param('token') token: string) {
    return this.invitations.getByToken(token);
  }

  // --- Authed: accept (membership not required — the token is authority) ------
  @Post('invitations/:token/accept')
  @UseGuards(AuthGuard)
  accept(@CurrentActor() actor: Actor, @Param('token') token: string) {
    return this.invitations.acceptInvitation(actor, token);
  }

  // --- Authed + member:manage: create / list / revoke ------------------------
  @Post('events/:eventId/invitations')
  @UseGuards(AuthGuard)
  async create(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: CreateInvitationDto,
  ) {
    return this.invitations.createInvitation(await this.ctx(actor, eventId), {
      role: dto.role,
      invitedPhone: dto.invitedPhone,
      maxUses: dto.maxUses,
      ttlSeconds: dto.ttlSeconds,
    });
  }

  @Get('events/:eventId/invitations')
  @UseGuards(AuthGuard)
  async list(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.invitations.listInvitations(await this.ctx(actor, eventId));
  }

  @Post('events/:eventId/invitations/:id/revoke')
  @UseGuards(AuthGuard)
  async revoke(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Param('id') id: string,
  ) {
    await this.invitations.revokeInvitation(await this.ctx(actor, eventId), id);
    return { ok: true };
  }

  // --- Member management (list members & update role) ------------------------
  @Get('events/:eventId/members')
  @UseGuards(AuthGuard)
  async listMembers(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.membership.listMembers(await this.ctx(actor, eventId));
  }

  @Post('events/:eventId/members/:targetUserId/role')
  @UseGuards(AuthGuard)
  async updateMemberRole(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Param('targetUserId') targetUserId: string,
    @Body() dto: { role: import('@prisma/client').EventRole },
  ) {
    return this.membership.updateRole(await this.ctx(actor, eventId), targetUserId, dto.role);
  }
}
