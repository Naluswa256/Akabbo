import { Actor, OperationContext } from '@akabbo/access';
import { EventService, MembershipService } from '@akabbo/ledger';
import { ConversationRef, ConversationService } from './conversation.service';

export interface CreatedEvent {
  id: string;
  name: string;
  targetAmount: string | null;
  eventDate: string | null;
  slug: string;
}

export interface MyEvent {
  id: string;
  name: string;
  status: string;
}

/**
 * The user/conversation-level context the agent loop operates in (next-increment
 * §8). It abstracts "which event am I acting on" so the loop can:
 *  • resolve the ACTIVE event (or report there is none → the model asks which),
 *  • CREATE an event (no event context yet),
 *  • SWITCH between the user's events,
 * without the loop knowing whether it is a one-off event-scoped call or a
 * persistent conversation. The active event is a convenience — every action
 * still passes the permission gate inside the domain services.
 */
export interface AgentSession {
  readonly actor: Actor;
  /** The active event id after any in-turn create/switch (for metering/response). */
  readonly currentActiveEventId: string | null;
  /** The permission-resolved context for the active event, or null if none. */
  activeEventCtx(): Promise<OperationContext | null>;
  /** Create an event and make it active. */
  createEvent(input: {
    name: string;
    targetAmount?: bigint;
    eventDate?: Date;
  }): Promise<CreatedEvent>;
  /** Update the ACTIVE event's name/target/date (no active event → an error). */
  updateEvent(input: {
    name?: string;
    targetAmount?: bigint;
    eventDate?: Date;
  }): Promise<{ ok: boolean; event?: CreatedEvent; error?: string }>;
  /** Switch the active event (must be one the user belongs to). */
  switchEvent(eventId: string): Promise<{ ok: boolean; name?: string; error?: string }>;
  /** The events this user can act on (for "which event?" disambiguation). */
  listMyEvents(): Promise<MyEvent[]>;
}

/**
 * A conversation-backed session: the active event is persisted on the
 * Conversation row and survives across turns; "switch to the funeral" updates
 * it. Membership is re-checked on every resolution, so a stale pointer to an
 * event the user no longer belongs to simply resolves to "no active event".
 */
export class ConversationSession implements AgentSession {
  private activeEventId: string | null;

  constructor(
    readonly actor: Actor,
    private readonly conversation: ConversationRef,
    private readonly events: EventService,
    private readonly membership: MembershipService,
    private readonly conversations: ConversationService,
  ) {
    this.activeEventId = conversation.activeEventId;
  }

  /** The active event id after any in-turn create/switch (for the API response). */
  get currentActiveEventId(): string | null {
    return this.activeEventId;
  }

  async activeEventCtx(): Promise<OperationContext | null> {
    if (!this.activeEventId) return null;
    try {
      const event = await this.membership.requireContext(this.actor, this.activeEventId);
      return { actor: this.actor, event };
    } catch {
      // The pointer is stale (event gone / membership removed) — clear it.
      this.activeEventId = null;
      await this.conversations.setActiveEvent(this.conversation.id, null);
      return null;
    }
  }

  async createEvent(input: {
    name: string;
    targetAmount?: bigint;
    eventDate?: Date;
  }): Promise<CreatedEvent> {
    const summary = await this.events.createEvent(this.actor, input);
    await this.setActive(summary.id);
    return {
      id: summary.id,
      name: summary.name,
      targetAmount: summary.targetAmount,
      eventDate: summary.eventDate,
      slug: summary.slug,
    };
  }

  /**
   * Change the active event's own fields (target/date/name) — distinct from
   * `createEvent`: this never creates a new event and never touches the
   * active-event-cap check, so it's safe on an event that's already active.
   */
  async updateEvent(input: {
    name?: string;
    targetAmount?: bigint;
    eventDate?: Date;
  }): Promise<{ ok: boolean; event?: CreatedEvent; error?: string }> {
    const ctx = await this.activeEventCtx();
    if (!ctx) {
      return { ok: false, error: 'No active event — switch to or create one first.' };
    }
    const summary = await this.events.updateEvent(ctx, input);
    return {
      ok: true,
      event: {
        id: summary.id,
        name: summary.name,
        targetAmount: summary.targetAmount,
        eventDate: summary.eventDate,
        slug: summary.slug,
      },
    };
  }

  async switchEvent(eventId: string): Promise<{ ok: boolean; name?: string; error?: string }> {
    try {
      await this.membership.requireContext(this.actor, eventId);
    } catch {
      return { ok: false, error: 'You are not a member of that event (or it does not exist).' };
    }
    await this.setActive(eventId);
    const mine = await this.listMyEvents();
    return { ok: true, name: mine.find((e) => e.id === eventId)?.name };
  }

  listMyEvents(): Promise<MyEvent[]> {
    return this.events
      .listMyEvents(this.actor)
      .then((rows) => rows.map((e) => ({ id: e.id, name: e.name, status: e.status })));
  }

  private async setActive(eventId: string): Promise<void> {
    this.activeEventId = eventId;
    await this.conversations.setActiveEvent(this.conversation.id, eventId);
  }
}
