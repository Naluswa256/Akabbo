import { Module } from '@nestjs/common';
import { AiModule } from '@akabbo/ai';
import { AuthModule } from '../auth/auth.module';
import { AssistantController } from './assistant.controller';

/** HTTP surface for the AI-first conversational operating interface (Part 1). */
@Module({
  imports: [AiModule, AuthModule],
  controllers: [AssistantController],
})
export class AssistantApiModule {}
