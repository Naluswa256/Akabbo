/**
 * SMS provider interface (Phase 3).
 *
 * SMS is our dominant variable cost (~85–94%) and the margin engine, so the
 * interface is shaped for idempotent, credit-aware sending: every send carries
 * an idempotency key tied to its originating outbox row so a retry never
 * double-sends (CLAUDE.md §3.5, metering doc §6). Africa's Talking is the
 * primary adapter; a local provider (e.g. EgoSMS) is the failover.
 */

export interface SmsSendRequest {
  /** E.164 recipient. Treated as PII — never logged (§3.10). */
  to: string;
  body: string;
  /** Registered alphanumeric sender ID (Uganda requirement). */
  senderId?: string;
  /**
   * Ties the send to its originating row. The provider (or our wrapper) MUST
   * dedupe on this so a retry is a no-op, not a second charge.
   */
  idempotencyKey: string;
}

export type SmsDeliveryStatus = 'queued' | 'sent' | 'delivered' | 'failed';

export interface SmsSendResult {
  providerMessageId: string;
  status: SmsDeliveryStatus;
  /** Provider-reported segment count (drives credit commit). */
  segments: number;
}

export interface SmsProvider {
  send(request: SmsSendRequest): Promise<SmsSendResult>;
  /**
   * Send a batch of PERSONALISED messages in one call (a reminder blast). One
   * network round-trip for many recipients — essential under the provider's
   * per-minute rate limit. Results are returned in the SAME ORDER as `requests`
   * so the caller can commit/refund each message's reserved credit.
   */
  sendBulk(requests: SmsSendRequest[]): Promise<SmsSendResult[]>;
  /** Current provider account balance (for cost/observability). */
  balance?(): Promise<{ balance: number; currency: string }>;
}
