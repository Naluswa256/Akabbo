import { Module } from '@nestjs/common';
import { BudgetKnowledgeService } from './budget-knowledge.service';

/**
 * Budget intelligence (pre-budgeting) — not part of the original 6-phase
 * plan. Deliberately lightweight: no LedgerModule/TenantContext dependency,
 * since BudgetKnowledgeSource/Observation are global reference data, not
 * tenant-scoped (see the exploration doc §2/§3). Depends only on the global
 * ProvidersModule (SEARCH_PROVIDER, LLM_PROVIDER) and the global PrismaModule
 * — both already available app-wide, so nothing to import here.
 */
@Module({
  providers: [BudgetKnowledgeService],
  exports: [BudgetKnowledgeService],
})
export class BudgetIntelligenceModule {}
