import { Module } from '@nestjs/common';
import { AiModule } from '@akabbo/ai';
import { BudgetIntelligenceModule } from '@akabbo/budget-intelligence';
import { AuthModule } from '../auth/auth.module';
import { AssistantController } from './assistant.controller';
import { LearningController } from '../learning/learning.controller';
import { AdminController } from '../admin/admin.controller';
import { AdminBudgetKnowledgeController } from '../admin/admin-budget-knowledge.controller';

/**
 * HTTP surface for the AI-first conversational operating interface (Part 1) +
 * Self-learning telemetry + admin reporting (users/plans, conversation
 * inbox, budget-knowledge uploads). AdminUsersService comes from the
 * globally-exported AccessModule — no separate import needed here.
 * BudgetIntelligenceModule is imported directly (not re-exported by
 * AiModule) for AdminBudgetKnowledgeController's BudgetKnowledgeService.
 */
@Module({
  imports: [AiModule, AuthModule, BudgetIntelligenceModule],
  controllers: [
    AssistantController,
    LearningController,
    AdminController,
    AdminBudgetKnowledgeController,
  ],
})
export class AssistantApiModule {}
