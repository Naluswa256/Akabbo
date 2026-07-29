import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Actor, OperationContext } from '@akabbo/access';
import {
  AllocationService,
  BudgetService,
  FulfillmentService,
  LedgerQueryService,
  MembershipService,
  PersonService,
  PledgeService,
  parseMoney,
} from '@akabbo/ledger';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentActor } from '../auth/current-actor.decorator';
import {
  CorrectFulfillmentDto,
  CorrectPledgeDto,
  CreatePersonDto,
  AddBudgetItemDto,
  AllocateDto,
  CreatePledgeDto,
  RecordDirectContributionDto,
  RecordFulfillmentDto,
  UpdateBudgetItemDto,
} from './ledger.dto';
import { LinkPersonDto } from '../invitation/invitation.dto';

/**
 * The typed ledger API. Every handler resolves the caller's {@link
 * OperationContext} (membership + role) for the event, then delegates to a
 * domain service. Both gates (permission + entitlement) live INSIDE those
 * services — this controller is a thin edge, and the AI orchestrator (Phase 2)
 * will call the exact same services with no privileged path.
 */
@Controller('events/:eventId')
@UseGuards(AuthGuard)
export class LedgerController {
  constructor(
    private readonly membership: MembershipService,
    private readonly people: PersonService,
    private readonly pledges: PledgeService,
    private readonly fulfillments: FulfillmentService,
    private readonly budget: BudgetService,
    private readonly allocations: AllocationService,
    private readonly queries: LedgerQueryService,
  ) {}

  private ctx(actor: Actor, eventId: string): Promise<OperationContext> {
    return this.membership.requireContext(actor, eventId).then((event) => ({ actor, event }));
  }

  // --- People ----------------------------------------------------------------
  @Post('people')
  async addPerson(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: CreatePersonDto,
  ) {
    return this.people.createPerson(await this.ctx(actor, eventId), {
      displayName: dto.displayName,
      phone: dto.phone,
      confirmSharedPhone: dto.confirmSharedPhone,
    });
  }

  @Get('people')
  async listPeople(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.people.listPeople(await this.ctx(actor, eventId));
  }

  /** Link a contributor Person to an authenticated User (the identity hinge). */
  @Post('people/:personId/link')
  async linkPerson(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Param('personId') personId: string,
    @Body() dto: LinkPersonDto,
  ) {
    return this.people.linkPersonToUser(await this.ctx(actor, eventId), personId, dto.userId);
  }

  // --- Pledges ---------------------------------------------------------------
  @Post('pledges')
  async createPledge(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: CreatePledgeDto,
  ) {
    return this.pledges.createPledge(await this.ctx(actor, eventId), {
      personId: dto.personId,
      committedValue: parseMoney(dto.committedValue),
      type: dto.type,
    });
  }

  @Post('pledges/:pledgeId/correct')
  async correctPledge(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Param('pledgeId') pledgeId: string,
    @Body() dto: CorrectPledgeDto,
  ) {
    return this.pledges.correctCommittedValue(
      await this.ctx(actor, eventId),
      pledgeId,
      parseMoney(dto.committedValue),
    );
  }

  @Post('pledges/:pledgeId/cancel')
  async cancelPledge(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Param('pledgeId') pledgeId: string,
  ) {
    return this.pledges.cancelPledge(await this.ctx(actor, eventId), pledgeId);
  }

  /** Every pledge with its person and full split history — the manual
   *  contributions/pledges edit panel's list view. Pass `?personId=` to drill
   *  into a single contributor's pledges/contributions (person-detail view). */
  @Get('pledges')
  async listPledges(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Query('personId') personId?: string,
  ) {
    return this.pledges.listPledges(await this.ctx(actor, eventId), personId);
  }

  @Get('pledges/:pledgeId/outstanding')
  async outstanding(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Param('pledgeId') pledgeId: string,
  ) {
    return this.queries.getPledgeOutstanding(await this.ctx(actor, eventId), pledgeId);
  }

  // --- Fulfillments ----------------------------------------------------------
  @Post('fulfillments')
  async recordFulfillment(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: RecordFulfillmentDto,
  ) {
    return this.fulfillments.recordFulfillment(await this.ctx(actor, eventId), {
      pledgeId: dto.pledgeId,
      value: parseMoney(dto.value),
      kind: dto.kind,
      method: dto.method,
      note: dto.note,
      idempotencyKey: dto.idempotencyKey,
      confirmDuplicate: dto.confirmDuplicate,
    });
  }

  /** Correct an individual split's amount — overpayment-guarded (never lets
   *  a pledge's splits sum past its committed value). */
  @Post('fulfillments/:fulfillmentId/correct')
  async correctFulfillment(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Param('fulfillmentId') fulfillmentId: string,
    @Body() dto: CorrectFulfillmentDto,
  ) {
    return this.fulfillments.correctValue(
      await this.ctx(actor, eventId),
      fulfillmentId,
      parseMoney(dto.value),
    );
  }

  /** A gift with no prior pledge (§15) — records commitment + discharge. */
  @Post('contributions')
  async recordDirectContribution(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: RecordDirectContributionDto,
  ) {
    return this.fulfillments.recordDirectContribution(await this.ctx(actor, eventId), {
      personId: dto.personId,
      value: parseMoney(dto.value),
      method: dto.method,
      type: dto.type,
      note: dto.note,
      description: dto.description,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  // --- Budget ----------------------------------------------------------------
  @Get('budget')
  async listBudget(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.budget.listItems(await this.ctx(actor, eventId));
  }

  @Post('budget/items')
  async addBudgetItem(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: AddBudgetItemDto,
  ) {
    return this.budget.addItem(await this.ctx(actor, eventId), {
      name: dto.name,
      targetValue: parseMoney(dto.targetValue),
    });
  }

  @Patch('budget/items/:itemId')
  async updateBudgetItem(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateBudgetItemDto,
  ) {
    return this.budget.updateItem(await this.ctx(actor, eventId), itemId, {
      name: dto.name,
      targetValue: dto.targetValue === undefined ? undefined : parseMoney(dto.targetValue),
      isPublic: dto.isPublic,
      expectedVersion: dto.expectedVersion,
    });
  }

  @Post('allocations')
  async allocate(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: AllocateDto,
  ) {
    return this.allocations.allocate(
      await this.ctx(actor, eventId),
      dto.fulfillmentId,
      dto.budgetItemId,
      parseMoney(dto.value),
    );
  }

  // --- Reads -----------------------------------------------------------------
  @Get('totals')
  async totals(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.queries.getEventTotals(await this.ctx(actor, eventId));
  }

  /** "How are we doing?" — the full grounded picture (§32, §40). */
  @Get('report')
  async report(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.queries.getEventReport(await this.ctx(actor, eventId));
  }

  /** Redacted funding view — the only financial signal a VIEWER may see (§12). */
  @Get('funding')
  async funding(@CurrentActor() actor: Actor, @Param('eventId') eventId: string) {
    return this.queries.getFundingSummary(await this.ctx(actor, eventId));
  }

  @Get('audit')
  async audit(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Query('resourceType') resourceType: string,
    @Query('resourceId') resourceId: string,
  ) {
    return this.queries.getAuditTrail(await this.ctx(actor, eventId), resourceType, resourceId);
  }
}
