import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Actor } from '@akabbo/access';
import { ConversationOrchestrator } from '@akabbo/ai';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentActor } from '../auth/current-actor.decorator';
import { ConverseDto } from './assistant.dto';

/**
 * The AI-first entry point (product spec Part 1). USER-scoped, not event-scoped:
 * the organizer just talks to Akabbo — it resolves which event they mean (or
 * asks), creates events, and acts, all within one persistent conversation. This
 * is the primary management surface; `/events/:id/assistant` is the event-fixed
 * shortcut.
 */
@Controller('assistant')
@UseGuards(AuthGuard)
export class AssistantController {
  constructor(private readonly orchestrator: ConversationOrchestrator) {}

  @Post()
  async converse(@CurrentActor() actor: Actor, @Body() dto: ConverseDto) {
    return this.orchestrator.converse(actor, dto.message, dto.conversationId);
  }
}
