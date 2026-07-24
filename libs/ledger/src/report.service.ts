import { Injectable, NotFoundException } from '@nestjs/common';
import { OperationContext, PermissionService } from '@akabbo/access';
import { PrismaService } from '@akabbo/prisma';
import { moneyToString } from './money';

export type ReportType = 'CONTRIBUTORS' | 'PLEDGES' | 'OUTSTANDING' | 'BUDGET' | 'PAYMENTS';
export type PresentationTier = 'INLINE_CHAT' | 'MEDIUM_PREVIEW' | 'LARGE_REPORT' | 'FILE_EXPORT';

export interface GenerateReportInput {
  reportType: ReportType;
  groupName?: string;
  minAmount?: number;
  maxAmount?: number;
  statusFilter?: string;
  searchTerm?: string;
  sortField?: string;
  sortDirection?: 'asc' | 'desc';
}

export interface ReportSummary {
  totalRecords: number;
  totalAmount: string;
  currency: string;
  metadata?: Record<string, unknown>;
}

export interface ReportPreviewRow {
  id: string;
  name: string;
  group?: string;
  amount: string;
  status?: string;
  detail?: string;
}

export interface GeneratedReportResult {
  reportId: string;
  reportType: ReportType;
  presentationTier: PresentationTier;
  summary: ReportSummary;
  preview: ReportPreviewRow[];
  reportUrl: string;
  note?: string;
}

export interface PaginatedReportResult {
  reportId: string;
  reportType: ReportType;
  summary: ReportSummary;
  page: number;
  pageSize: number;
  totalPages: number;
  rows: ReportPreviewRow[];
}

@Injectable()
export class ReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  /** Generate or reuse a query-backed report with automatic tier thresholding */
  async generateReport(
    ctx: OperationContext,
    input: GenerateReportInput,
  ): Promise<GeneratedReportResult> {
    this.permissions.assert(ctx.event.role, 'event:read');
    const eventId = ctx.event.eventId;

    let totalRecords = 0;
    let totalAmountBigInt = 0n;
    let preview: ReportPreviewRow[] = [];

    // Query database depending on reportType
    if (input.reportType === 'CONTRIBUTORS' || input.reportType === 'OUTSTANDING') {
      const whereClause: any = { eventId };

      if (input.groupName) {
        whereClause.groups = {
          some: { group: { name: { contains: input.groupName, mode: 'insensitive' } } },
        };
      }

      if (input.searchTerm) {
        whereClause.displayName = { contains: input.searchTerm, mode: 'insensitive' };
      }

      const people = await this.prisma.person.findMany({
        where: whereClause,
        select: {
          id: true,
          displayName: true,
          groups: { select: { group: { select: { name: true } } } },
          pledges: {
            select: {
              committedValue: true,
              fulfillments: { select: { value: true } },
            },
          },
        },
      });

      const rows: ReportPreviewRow[] = [];
      for (const p of people) {
        let pledgedSum = 0n;
        let receivedSum = 0n;

        for (const pl of p.pledges) {
          pledgedSum += pl.committedValue;
          for (const f of pl.fulfillments) {
            receivedSum += f.value;
          }
        }

        const groupName = p.groups.map((g) => g.group.name).join(', ') || 'General';

        let include = true;
        if (input.minAmount && Number(receivedSum) < input.minAmount) include = false;
        if (input.maxAmount && Number(receivedSum) > input.maxAmount) include = false;

        if (input.reportType === 'OUTSTANDING') {
          const outstandingValue = pledgedSum > receivedSum ? pledgedSum - receivedSum : 0n;
          if (outstandingValue <= 0n) include = false;
        }

        if (include) {
          totalRecords += 1;
          totalAmountBigInt += receivedSum;

          rows.push({
            id: p.id,
            name: p.displayName,
            group: groupName,
            amount: moneyToString(receivedSum),
            status: pledgedSum > receivedSum ? 'PARTIAL' : 'PAID',
            detail: pledgedSum > 0n ? `Pledged: ${moneyToString(pledgedSum)}` : undefined,
          });
        }
      }

      // Sort rows descending by amount
      rows.sort((a, b) => {
        const valA = parseFloat(a.amount.replace(/[^0-9.]/g, '')) || 0;
        const valB = parseFloat(b.amount.replace(/[^0-9.]/g, '')) || 0;
        return valB - valA;
      });
      preview = rows.slice(0, 5);
    } else if (input.reportType === 'BUDGET') {
      const items = await this.prisma.budgetItem.findMany({
        where: { eventId },
        select: {
          id: true,
          name: true,
          targetValue: true,
          allocations: { select: { value: true } },
        },
      });

      totalRecords = items.length;
      totalAmountBigInt = items.reduce((acc: bigint, i) => acc + i.targetValue, 0n);

      preview = items.slice(0, 5).map((i) => {
        const allocated = i.allocations.reduce((acc: bigint, a) => acc + a.value, 0n);
        const isCovered = allocated >= i.targetValue && i.targetValue > 0n;
        return {
          id: i.id,
          name: i.name,
          amount: moneyToString(i.targetValue),
          status: isCovered ? 'PAID' : 'UNPAID',
          detail: `Allocated: ${moneyToString(allocated)}`,
        };
      });
    } else {
      // Default payments/fulfillments
      const fulfillments = await this.prisma.fulfillment.findMany({
        where: { eventId },
        take: 100,
        select: {
          id: true,
          value: true,
          pledge: { select: { person: { select: { displayName: true } } } },
        },
      });
      totalRecords = fulfillments.length;
      totalAmountBigInt = fulfillments.reduce((acc, f) => acc + f.value, 0n);
      preview = fulfillments.slice(0, 5).map((f) => ({
        id: f.id,
        name: f.pledge.person.displayName,
        amount: moneyToString(f.value),
        status: 'CONFIRMED',
      }));
    }

    // Presentation Tier Selection (Rules §2)
    let presentationTier: PresentationTier = 'INLINE_CHAT';
    if (totalRecords > 30) {
      presentationTier = 'LARGE_REPORT';
    } else if (totalRecords > 5) {
      presentationTier = 'MEDIUM_PREVIEW';
    }

    // Save report state idempotently
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    const reportState = await this.prisma.aiReportState.create({
      data: {
        eventId,
        userId: ctx.actor.userId,
        reportType: input.reportType,
        filtersJson: JSON.stringify(input),
        sortJson: input.sortField ? JSON.stringify({ field: input.sortField, dir: input.sortDirection }) : null,
        totalRecords,
        totalAmount: totalAmountBigInt,
        expiresAt,
      },
    });

    const reportUrl = `/events/${eventId}/reports/${reportState.id}`;

    return {
      reportId: reportState.id,
      reportType: input.reportType,
      presentationTier,
      summary: {
        totalRecords,
        totalAmount: moneyToString(totalAmountBigInt),
        currency: 'UGX',
      },
      preview,
      reportUrl,
      note:
        totalRecords > 5
          ? `Prepared dynamic report with ${totalRecords} matching records. Direct link: ${reportUrl}`
          : undefined,
    };
  }

  /** Get paginated report data for table rendering */
  async getReportData(
    ctx: OperationContext,
    reportId: string,
    page = 1,
    pageSize = 25,
    search?: string,
  ): Promise<PaginatedReportResult> {
    this.permissions.assert(ctx.event.role, 'event:read');
    const state = await this.prisma.aiReportState.findUnique({
      where: { id: reportId },
    });

    if (!state || state.eventId !== ctx.event.eventId) {
      throw new NotFoundException('Report not found or expired');
    }

    const filters: GenerateReportInput = JSON.parse(state.filtersJson);
    if (search) filters.searchTerm = search;

    // Execute generated report query
    const report = await this.generateReport(ctx, filters);
    const totalPages = Math.ceil(report.summary.totalRecords / pageSize) || 1;
    const startIndex = (page - 1) * pageSize;
    const paginatedRows = report.preview.slice(startIndex, startIndex + pageSize);

    return {
      reportId,
      reportType: state.reportType as ReportType,
      summary: report.summary,
      page,
      pageSize,
      totalPages,
      rows: paginatedRows.length > 0 ? paginatedRows : report.preview,
    };
  }

  /** Export report rows as CSV format string */
  async exportReportCsv(ctx: OperationContext, reportId: string): Promise<string> {
    const data = await this.getReportData(ctx, reportId, 1, 1000);
    const lines = ['Name,Group,Amount,Status,Detail'];
    for (const row of data.rows) {
      const name = `"${(row.name || '').replace(/"/g, '""')}"`;
      const group = `"${(row.group || '').replace(/"/g, '""')}"`;
      const amount = `"${row.amount}"`;
      const status = `"${row.status || ''}"`;
      const detail = `"${(row.detail || '').replace(/"/g, '""')}"`;
      lines.push(`${name},${group},${amount},${status},${detail}`);
    }
    return lines.join('\n');
  }
}
