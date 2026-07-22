import { ConflictException } from '@nestjs/common';

/**
 * Raised when a payment looks like one already recorded moments ago for the
 * same pledge and amount (§25). We do NOT silently record a second payment and
 * we do NOT silently swallow it — we stop and ask a human, because both
 * mistakes are expensive with money.
 *
 * The caller (AI or API) re-submits with `confirmDuplicate: true` to record it
 * as a genuinely separate payment.
 */
export class DuplicateSuspectedException extends ConflictException {
  constructor(
    readonly existingFulfillmentId: string,
    readonly value: string,
    readonly recordedAt: string,
  ) {
    super({
      error: 'duplicate_suspected',
      message:
        `A payment of ${value} was already recorded for this pledge at ${recordedAt}. ` +
        'Record another one only if it is genuinely a separate payment.',
      existingFulfillmentId,
    });
  }
}
