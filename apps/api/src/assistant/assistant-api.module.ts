import { Module } from '@nestjs/common';
import { AiModule } from '@akabbo/ai';
import { BillingModule } from '@akabbo/billing';
import { BudgetIntelligenceModule } from '@akabbo/budget-intelligence';
import { AuthModule } from '../auth/auth.module';
import { AssistantController } from './assistant.controller';
import { LearningController } from '../learning/learning.controller';
import { AdminController } from '../admin/admin.controller';
import { AdminBudgetKnowledgeController } from '../admin/admin-budget-knowledge.controller';
import { AdminBillingController } from '../admin/admin-billing.controller';

/**
 * HTTP surface for the AI-first conversational operating interface (Part 1) +
 * Self-learning telemetry + admin reporting (users/plans, conversation
 * inbox, budget-knowledge uploads, invoice reconciliation). AdminUsersService
 * comes from the globally-exported AccessModule — no separate import needed
 * here. BudgetIntelligenceModule/BillingModule are imported directly (not
 * re-exported by AiModule) for their respective admin controllers.
 */
@Module({
  imports: [AiModule, AuthModule, BudgetIntelligenceModule, BillingModule],
  controllers: [
    AssistantController,
    LearningController,
    AdminController,
    AdminBudgetKnowledgeController,
    AdminBillingController,
  ],
})
export class AssistantApiModule {}
