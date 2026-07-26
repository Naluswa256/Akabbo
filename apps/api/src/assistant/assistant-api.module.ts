import { Module } from '@nestjs/common';
import { AiModule } from '@akabbo/ai';
import { AuthModule } from '../auth/auth.module';
import { AssistantController } from './assistant.controller';
import { LearningController } from '../learning/learning.controller';
import { AdminController } from '../admin/admin.controller';

/**
 * HTTP surface for the AI-first conversational operating interface (Part 1) +
 * Self-learning telemetry + admin reporting (users/plans, conversation
 * inbox). AdminUsersService comes from the globally-exported AccessModule —
 * no separate import needed here.
 */
@Module({
  imports: [AiModule, AuthModule],
  controllers: [AssistantController, LearningController, AdminController],
})
export class AssistantApiModule {}
