import { ForbiddenException } from '@nestjs/common';
import { EventStatus } from '@prisma/client';

/**
 * THE THIRD GATE (§33). Every mutating action passes, in order:
 *   1. permission   — `can(role, action)`
 *   2. entitlement  — plan limits / credits
 *   3. event status — is this event still writable?
 *
 * CLOSED and ARCHIVED events are READ-ONLY: the record of what happened is
 * preserved and cannot drift. To make an authorized correction after closing,
 * an owner reopens the event (→ ACTIVE), which is itself audited — so a
 * post-closure change is always visible rather than silent.
 */
const WRITABLE: ReadonlySet<EventStatus> = new Set([
  EventStatus.DRAFT,
  EventStatus.ACTIVE,
  EventStatus.PAUSED,
]);

export function isWritable(status: EventStatus): boolean {
  return WRITABLE.has(status);
}

/** Throws 403 when the event is closed/archived. */
export function assertEventWritable(status: EventStatus): void {
  if (!isWritable(status)) {
    throw new ForbiddenException(
      `This event is ${status.toLowerCase()} and is read-only. Reopen it to make changes.`,
    );
  }
}
