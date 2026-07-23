import { Module } from '@nestjs/common';
import { AiModule } from '@akabbo/ai';
import { AuthModule } from '../auth/auth.module';
import { AssistantController } from './assistant.controller';
import { LearningController } from '../learning/learning.controller';

/** HTTP surface for the AI-first conversational operating interface (Part 1) + Self-learning telemetry. */
@Module({
  imports: [AiModule, AuthModule],
  controllers: [AssistantController, LearningController],
})
export class AssistantApiModule {}
