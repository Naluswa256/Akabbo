import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Actor, OperationContext } from '@akabbo/access';
import { MembershipService, ReportService } from '@akabbo/ledger';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentActor } from '../auth/current-actor.decorator';

@Controller('events/:eventId/reports')
@UseGuards(AuthGuard)
export class ReportController {
  constructor(
    private readonly reportService: ReportService,
    private readonly membership: MembershipService,
  ) {}

  private ctx(actor: Actor, eventId: string): Promise<OperationContext> {
    return this.membership.requireContext(actor, eventId).then((event) => ({ actor, event }));
  }

  @Get(':reportId')
  async getReportData(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Param('reportId') reportId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
  ) {
    const ctx = await this.ctx(actor, eventId);
    const pageNum = parseInt(page || '1', 10);
    const sizeNum = parseInt(pageSize || '25', 10);
    return this.reportService.getReportData(ctx, reportId, pageNum, sizeNum, search);
  }

  @Get(':reportId/export')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="report-export.csv"')
  async exportCsv(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Param('reportId') reportId: string,
  ) {
    const ctx = await this.ctx(actor, eventId);
    return this.reportService.exportReportCsv(ctx, reportId);
  }
}
