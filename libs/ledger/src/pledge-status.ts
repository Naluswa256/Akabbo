import { PledgeStatus } from '@prisma/client';

/**
 * Derive a pledge's fulfillment status from the numbers — the single source of
 * truth for status (never set by hand, never by the LLM). CANCELLED is a
 * separate lifecycle concern handled by the cancel path and is preserved here.
 */
export function deriveStatus(
  committedValue: bigint,
  totalFulfilled: bigint,
  cancelled = false,
): PledgeStatus {
  if (cancelled) return PledgeStatus.CANCELLED;
  if (totalFulfilled <= 0n) return PledgeStatus.PLEDGED;
  if (totalFulfilled >= committedValue) return PledgeStatus.FULFILLED;
  return PledgeStatus.PARTIALLY_FULFILLED;
}

/** outstanding = committed − Σ fulfillments, floored at zero (§3, blueprint §3). */
export function outstanding(committedValue: bigint, totalFulfilled: bigint): bigint {
  const remaining = committedValue - totalFulfilled;
  return remaining > 0n ? remaining : 0n;
}
