import { Injectable } from '@nestjs/common';
import { ConversationMessageRole } from '@prisma/client';
import { Actor } from '@akabbo/access';
import { ReportRef } from '@akabbo/ledger';
import { EventService, MembershipService } from '@akabbo/ledger';
import { AssistantService } from './assistant.service';
import { ConversationService } from './conversation.service';
import { ConversationSession } from './agent-session';

export interface ConverseResult {
  conversationId: string;
  activeEventId: string | null;
  reply: string;
  /** Pending-confirmation ids the turn staged (writes awaiting the human). */
  staged: string[];
  /** Structured report references produced this turn — frontend renders chips from these. */
  reportRefs: ReportRef[];
}

/**
 * The AI-first entry point (product spec Part 1): the organizer talks to Akabbo
 * and it manages the event. Ties together conversation memory, active-event
 * resolution and the agent loop:
 *   1. load (or start) the caller's conversation,
 *   2. replay prior turns as context,
 *   3. run the agent over a conversation session (create/switch/act),
 *   4. persist both the human turn and the AI reply.
 *
 * The transcript is context, never truth (§22/§32): the loop still re-queries
 * canonical data and stages writes for confirmation.
 */
@Injectable()
export class ConversationOrchestrator {
  constructor(
    private readonly conversations: ConversationService,
    private readonly assistant: AssistantService,
    private readonly events: EventService,
    private readonly membership: MembershipService,
  ) {}

  async converse(actor: Actor, message: string, conversationId?: string): Promise<ConverseResult> {
    const conversation = await this.conversations.getOrCreate(actor, conversationId);
    const history = await this.conversations.history(conversation.id);
    await this.conversations.appendMessage(conversation.id, ConversationMessageRole.user, message);

    const session = new ConversationSession(
      actor,
      conversation,
      this.events,
      this.membership,
      this.conversations,
    );

    const result = await this.assistant.chatSession(session, message, history);
    await this.conversations.appendMessage(
      conversation.id,
      ConversationMessageRole.assistant,
      result.reply,
    );

    return {
      conversationId: conversation.id,
      activeEventId: session.currentActiveEventId,
      reply: result.reply,
      staged: result.staged,
      reportRefs: result.reportRefs,
    };
  }
}
