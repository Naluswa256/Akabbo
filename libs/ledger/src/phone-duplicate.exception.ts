import { ConflictException } from '@nestjs/common';

/**
 * Raised when a phone number being attached to a person is already on file
 * for a DIFFERENT person in the same event (§ same integrity posture as
 * DuplicateSuspectedException for payments). We do NOT silently attach it —
 * two contributors sharing one real phone means SMS reminders/announcements
 * land on that one phone addressed to whichever name happened to be
 * personalised into each message, which reads as garbled/contradictory to
 * the person holding it.
 *
 * A shared/family phone IS a legitimate real-world case (one household
 * number covering several named pledges), so this is not a hard block — the
 * caller re-submits with `confirmSharedPhone: true` to attach it anyway.
 */
export class PhoneAlreadyAttachedException extends ConflictException {
  constructor(
    readonly existingPersonId: string,
    readonly existingDisplayName: string,
    readonly phone: string,
  ) {
    super({
      error: 'phone_already_attached',
      message:
        `${phone} is already on file for ${existingDisplayName} in this event. ` +
        'If this is genuinely a shared/family number, confirm to attach it anyway — ' +
        'otherwise use the correct number.',
      existingPersonId,
      existingDisplayName,
    });
  }
}
