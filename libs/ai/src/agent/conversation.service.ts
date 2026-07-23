import { Injectable } from '@nestjs/common';
import { ConversationMessageRole } from '@prisma/client';
import { Actor } from '@akabbo/access';
import { PrismaService } from '@akabbo/prisma';
import { LlmMessage } from '@akabbo/providers';

export interface ConversationRef {
  id: string;
  activeEventId: string | null;
}

/** How many prior turns to replay as context (keeps the prompt bounded). */
const HISTORY_LIMIT = 20;

/**
 * Persistent multi-turn conversation memory for the AI operating layer (next-
 * increment §7). USER-scoped: a conversation may precede any event and switch
 * between the user's events, so it is not under event RLS — access is enforced
 * here by `userId` (the same pattern as the `user`/`auth_otp_challenge` tables).
 *
 * Conversation memory is NOT database truth (§22): it stores what was SAID, and
 * the active-event pointer, but every authoritative number is still re-queried
 * from canonical data each turn.
 */
@Injectable()
export class ConversationService {
  constructor(private readonly prisma: PrismaService) { }

  /** Load the caller's conversation, or start a fresh one. Ownership-checked. */
  async getOrCreate(actor: Actor, conversationId?: string): Promise<ConversationRef> {
    if (conversationId) {
      const existing = await this.prisma.conversation.findFirst({
        where: { id: conversationId, userId: actor.userId },
        select: { id: true, activeEventId: true },
      });
      if (existing) return existing;
    }
    return this.prisma.conversation.create({
      data: { userId: actor.userId },
      select: { id: true, activeEventId: true },
    });
  }

  /** Replay the last {@link HISTORY_LIMIT} turns as LLM context, oldest first. */
  async history(conversationId: string): Promise<LlmMessage[]> {
    const rows = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
      select: { role: true, content: true },
    });
    return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
  }

  appendMessage(
    conversationId: string,
    role: ConversationMessageRole,
    content: string,
  ): Promise<unknown> {
    return this.prisma.message.create({
      data: { conversationId, role, content },
      select: { id: true },
    });
  }

  /** Point the conversation at (or clear) the event it is now talking about. */
  setActiveEvent(conversationId: string, eventId: string | null): Promise<unknown> {
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { activeEventId: eventId },
      select: { id: true },
    });
  }
}
