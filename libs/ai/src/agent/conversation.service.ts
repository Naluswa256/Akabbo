import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConversationMessageRole } from '@prisma/client';
import { Actor } from '@akabbo/access';
import { PrismaService } from '@akabbo/prisma';
import { LlmMessage } from '@akabbo/providers';

export interface ConversationRef {
  id: string;
  activeEventId: string | null;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  activeEventId: string | null;
  createdAt: string;
  /** Bumped on every appended message — the real "last activity" signal, not
   *  just when the row itself is touched (e.g. switching the active event). */
  updatedAt: string;
}

export interface MessageView {
  id: string;
  role: ConversationMessageRole;
  content: string;
  createdAt: string;
}

/** How many prior turns to replay as context (keeps the prompt bounded). */
const HISTORY_LIMIT = 20;
/** How many conversations to show in "resume where you left off". */
const CONVERSATION_LIST_LIMIT = 20;

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
  constructor(private readonly prisma: PrismaService) {}

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

  async appendMessage(
    conversationId: string,
    role: ConversationMessageRole,
    content: string,
  ): Promise<unknown> {
    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: { conversationId, role, content },
        select: { id: true },
      }),
      // Touch updatedAt so "resume where you left off" can sort by real last
      // activity — @updatedAt only bumps on a write to Conversation itself,
      // never automatically when a related Message is created.
      this.prisma.conversation.update({
        where: { id: conversationId },
        data: {},
        select: { id: true },
      }),
    ]);
    return message;
  }

  /** Point the conversation at (or clear) the event it is now talking about. */
  setActiveEvent(conversationId: string, eventId: string | null): Promise<unknown> {
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { activeEventId: eventId },
      select: { id: true },
    });
  }

  /**
   * "Resume where you left off": the user's own conversations, most recently
   * active first. Ownership is implicit in the `userId` filter — there is no
   * cross-user leakage path here.
   */
  async listMine(userId: string, limit = CONVERSATION_LIST_LIMIT): Promise<ConversationSummary[]> {
    const rows = await this.prisma.conversation.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: { id: true, title: true, activeEventId: true, createdAt: true, updatedAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      activeEventId: r.activeEventId,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /**
   * Full message history for display (oldest first) — distinct from
   * `history()`, which is a bounded, role/content-only slice fed to the LLM.
   * Ownership-checked: a conversation is USER-scoped, not RLS/event-scoped
   * (see class docs), so this is the enforcement point.
   */
  async getMessages(conversationId: string, actor: Actor): Promise<MessageView[]> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { userId: true },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.userId !== actor.userId) {
      throw new ForbiddenException('Not your conversation');
    }
    const rows = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true, createdAt: true },
    });
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }
}
