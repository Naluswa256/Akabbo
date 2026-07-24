import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Actor, OperationContext } from '@akabbo/access';
import { MembershipService, ReportFilters, ReportService } from '@akabbo/ledger';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentActor } from '../auth/current-actor.decorator';

/**
 * Stateless report endpoint — filters come from query params, always queries live data.
 * No reportId, no snapshot, no staleness. The frontend opens these URLs from reportRefs[]
 * returned by the AI, or from deep-links.
 */
@Controller('events/:eventId/report')
@UseGuards(AuthGuard)
export class ReportController {
  constructor(
    private readonly reportService: ReportService,
    private readonly membership: MembershipService,
  ) {}

  private ctx(actor: Actor, eventId: string): Promise<OperationContext> {
    return this.membership.requireContext(actor, eventId).then((event) => ({ actor, event }));
  }

  private parseFilters(query: Record<string, string>): ReportFilters {
    return {
      reportType: 'CONTRIBUTORS',
      status: (query.status as ReportFilters['status']) ?? 'all',
      groupName: query.groupName,
      minAmount: query.minAmount ? Number(query.minAmount) : undefined,
      maxAmount: query.maxAmount ? Number(query.maxAmount) : undefined,
      searchTerm: query.search,
      sortField: query.sort as ReportFilters['sortField'],
      sortDirection: (query.dir as ReportFilters['sortDirection']) ?? 'desc',
    };
  }

  /**
   * GET /events/:eventId/report/contributors
   * Stateless paginated contributor list with filtering, sorting, and search.
   * All query params are live — totals and rows always consistent.
   */
  @Get('contributors')
  async getContributors(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Query() query: Record<string, string>,
  ) {
    const ctx = await this.ctx(actor, eventId);
    const page = parseInt(query.page || '1', 10);
    const pageSize = Math.min(parseInt(query.pageSize || '25', 10), 100);
    const filters = this.parseFilters(query);
    return this.reportService.getPaginatedContributors(ctx, filters, page, pageSize, query.search);
  }

  /**
   * GET /events/:eventId/report/contributors/export
   * CSV download — same filters as the paginated endpoint, always live query.
   */
  @Get('contributors/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="contributors.csv"')
  async exportContributors(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Query() query: Record<string, string>,
  ) {
    const ctx = await this.ctx(actor, eventId);
    const filters = this.parseFilters(query);
    return this.reportService.exportCsv(ctx, filters);
  }
}
