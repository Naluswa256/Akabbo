import { EventRole, EventStatus } from '@prisma/client';

/**
 * The authenticated identity making a request. Establishes WHO, not what they
 * may do — authorization is resolved separately by the permission engine
 * against the actor's role in a specific event (§10: authority lives in code).
 */
export interface Actor {
  userId: string;
  phoneVerified: boolean;
}

/**
 * An actor's resolved standing within one event (the tenant). `role` comes from
 * the `event_member` row for (userId, eventId); absence of a membership means
 * no access at all.
 */
export interface EventContext {
  eventId: string;
  role: EventRole;
  /**
   * Event lifecycle status, resolved alongside the role so the status gate
   * (§33) is a pure in-memory check at the point of mutation rather than an
   * extra query per write.
   */
  status: EventStatus;
}

/**
 * The full context every domain operation runs under: WHO (actor) and their
 * standing in WHICH event (event). Domain services take this so both gates —
 * permission (role) and entitlement (scope) — and audit provenance (actor) are
 * always available at the point of mutation.
 */
export interface OperationContext {
  actor: Actor;
  event: EventContext;
}
