import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Actor, OperationContext } from '@akabbo/access';
import { EventService, MembershipService, parseMoney } from '@akabbo/ledger';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentActor } from '../auth/current-actor.decorator';
import { AddMemberDto, CreateEventDto, SetEventStatusDto, UpdateEventDto } from './ledger.dto';

/**
 * Event lifecycle + membership. Creating an event makes the caller OWNER;
 * membership changes are owner-only (enforced in the domain service, not here).
 * Contribution collection is an EVENT STATE (§12) — `PATCH /status` drives
 * DRAFT→ACTIVE→PAUSED→CLOSED→ARCHIVED, and CLOSED/ARCHIVED are read-only (§33).
 */
@Controller('events')
@UseGuards(AuthGuard)
export class EventsController {
  constructor(
    private readonly events: EventService,
    private readonly membership: MembershipService,
  ) {}

  private ctx(actor: Actor, eventId: string): Promise<OperationContext> {
    return this.membership.requireContext(actor, eventId).then((event) => ({ actor, event }));
  }

  @Post()
  createEvent(@CurrentActor() actor: Actor, @Body() dto: CreateEventDto) {
    return this.events.createEvent(actor, {
      name: dto.name,
      currency: dto.currency,
      targetAmount: dto.targetAmount === undefined ? undefined : parseMoney(dto.targetAmount),
      eventDate: dto.eventDate === undefined ? undefined : new Date(dto.eventDate),
      timezone: dto.timezone,
      country: dto.country,
    });
  }

  /** "My Events" (§26) — every event this user is an active member of. */
  @Get()
  listMyEvents(@CurrentActor() actor: Actor) {
    return this.events.listMyEvents(actor);
  }

  @Get(':eventId')
  async getEvent(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.events.getEvent(await this.ctx(actor, eventId));
  }

  @Patch(':eventId')
  async updateEvent(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: UpdateEventDto,
  ) {
    return this.events.updateEvent(await this.ctx(actor, eventId), {
      name: dto.name,
      targetAmount: dto.targetAmount === undefined ? undefined : parseMoney(dto.targetAmount),
      eventDate: dto.eventDate === undefined ? undefined : new Date(dto.eventDate),
    });
  }

  @Patch(':eventId/status')
  async setStatus(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: SetEventStatusDto,
  ) {
    return this.events.setStatus(await this.ctx(actor, eventId), dto.status);
  }

  @Post(':eventId/members')
  async addMember(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: AddMemberDto,
  ) {
    const ctx = await this.ctx(actor, eventId);
    return this.membership.addMember(ctx, dto.userId, dto.role);
  }
}
