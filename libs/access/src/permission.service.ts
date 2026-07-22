import { ForbiddenException, Injectable } from '@nestjs/common';
import { EventRole } from '@prisma/client';
import { Action } from './actions';

/**
 * Deterministic permission engine — `can(actor, action, resource)` (§3.6, §10).
 *
 * This is pure, in-code, and testable: role × action → boolean. It lives
 * OUTSIDE any LLM and is called INSIDE domain services before every mutation.
 * The LLM's output is only ever a *request*; this decides authority.
 *
 * Fail closed: an unknown role or action denies.
 */

// The role → allowed-actions matrix. Read it as "what each role may do".
const FULL_LEDGER: Action[] = [
  'person:write',
  'person:merge',
  'pledge:write',
  'pledge:cancel',
  'fulfillment:write',
  'fulfillment:correct',
  'ledger:read_funding',
  'ledger:read_amounts',
  'budget:read',
  'budget:write',
  'group:read',
  'group:write',
  'document:upload',
  'document:read',
];

// Managing what the PUBLIC page shows (announcements + how-to-contribute) is
// day-to-day coordination — the same roles that run the event. Toggling public
// visibility / revoking the link (`public:configure`) is owner-tier, added
// separately below.
const PUBLISHING: Action[] = [
  'announcement:read',
  'announcement:write',
  'payment_instruction:read',
  'payment_instruction:write',
  // Sending reminders/announcements is day-to-day coordination reach.
  'sms:send',
  'sms:read',
];

const MATRIX: Record<EventRole, ReadonlySet<Action>> = {
  OWNER: new Set<Action>([
    'event:read',
    'event:update',
    'member:manage',
    'public:configure',
    ...FULL_LEDGER,
    ...PUBLISHING,
  ]),
  // Co-owner is a peer of the owner day-to-day, including membership control and
  // public-visibility configuration.
  // (Owner-only distinctions like delete-event/manage-subscription do not exist
  // as actions yet; they will be OWNER-only when added.)
  CO_OWNER: new Set<Action>([
    'event:read',
    'event:update',
    'member:manage',
    'public:configure',
    ...FULL_LEDGER,
    ...PUBLISHING,
  ]),
  // Coordinator runs the event day-to-day: full ledger + people + event
  // settings + public publishing, but not membership/role changes or the
  // public-visibility switch (owner-tier).
  COORDINATOR: new Set<Action>(['event:read', 'event:update', ...FULL_LEDGER, ...PUBLISHING]),
  // Finance records money: people, pledges, payments, corrections — but no
  // event settings, membership control, or public publishing.
  FINANCE: new Set<Action>(['event:read', ...FULL_LEDGER]),
  // Viewer is read-only AND amount-blind: the redacted funding summary and the
  // budget PLAN (planned spend, not contributor amounts), but never amounts and
  // no writes.
  VIEWER: new Set<Action>(['event:read', 'ledger:read_funding', 'budget:read', 'group:read']),
};

@Injectable()
export class PermissionService {
  /** Pure predicate: may this role perform this action? */
  can(role: EventRole, action: Action): boolean {
    return MATRIX[role]?.has(action) ?? false;
  }

  /**
   * Enforce a permission; throws 403 if denied. Domain services call this
   * before acting so the check is impossible to bypass via any entrypoint
   * (typed API today, AI tools in Phase 2).
   */
  assert(role: EventRole, action: Action): void {
    if (!this.can(role, action)) {
      throw new ForbiddenException(`Role ${role} may not perform ${action}`);
    }
  }
}
