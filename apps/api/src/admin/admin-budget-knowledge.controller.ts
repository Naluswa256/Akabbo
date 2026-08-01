import { Body, Controller, ForbiddenException, Get, Headers, Post, Query } from '@nestjs/common';
import { BudgetKnowledgeSourceType } from '@prisma/client';
import { BudgetKnowledgeService } from '@akabbo/budget-intelligence';
import { UploadBudgetKnowledgeDto } from './admin-budget-knowledge.dto';

/**
 * Admin-only: feed the shared pre-budgeting knowledge base from a REAL
 * person's real budget (Word doc, Excel sheet, screenshot, or PDF) that an
 * admin has personally sourced and vetted — never scraped. This is the
 * deliberately curated counterpart to the automatic paths (live search,
 * an organizer's own per-event upload): admin-sourced content is written
 * as `admin_upload` / HIGH reliability, which is what makes it take
 * priority over other sources for the same category (see
 * BudgetKnowledgeService.getRecommendation → aggregateByCategory).
 *
 * Gated the same way every other admin surface in this app is (see
 * AdminController) — a shared secret header, not a JWT/role. There is no
 * admin ROLE in this system yet.
 */
@Controller('admin/budget-knowledge')
export class AdminBudgetKnowledgeController {
  constructor(private readonly budgetKnowledge: BudgetKnowledgeService) {}

  private assertAdminSecret(secretHeader?: string): void {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret) {
      throw new ForbiddenException('Admin surface is not configured (ADMIN_SECRET unset)');
    }
    if (!secretHeader || secretHeader !== adminSecret) {
      throw new ForbiddenException('Invalid admin secret key for admin surface');
    }
  }

  @Post('uploads')
  async upload(
    @Body() dto: UploadBudgetKnowledgeDto,
    @Headers('x-akabbo-admin-secret') secret?: string,
  ) {
    this.assertAdminSecret(secret);
    return this.budgetKnowledge.ingestFromDocument({
      filename: dto.filename,
      mimeType: dto.mimeType,
      data: Buffer.from(dto.dataBase64, 'base64'),
      eventTypeHint: dto.eventTypeHint,
      regionHint: dto.regionHint,
      note: dto.note,
    });
  }

  /** Browse what's already in the knowledge base — every source type, not
   *  just admin uploads, so the panel shows the full picture (curated seed,
   *  live search, organizer uploads, admin uploads) in one place. */
  @Get('sources')
  async listSources(
    @Headers('x-akabbo-admin-secret') secret?: string,
    @Query('sourceType') sourceType?: BudgetKnowledgeSourceType,
    @Query('eventType') eventType?: string,
    @Query('limit') limit?: string,
  ) {
    this.assertAdminSecret(secret);
    return this.budgetKnowledge.listSources({
      sourceType,
      eventType,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
