/**
 * Email provider interface (email OTP auth). Mirrors the SmsProvider seam:
 * a narrow, swappable-by-config interface, never a vendor SDK in domain
 * code. Unlike SMS, email OTP is not credit-metered — sending it is a cost
 * of doing business, not a billed feature — so this interface stays minimal
 * (no bulk send, no balance check) rather than mirroring SmsProvider's
 * campaign-shaped surface it doesn't need.
 */

export interface EmailSendRequest {
  /** Recipient address. Treated as PII — never logged (§3.10). */
  to: string;
  subject: string;
  /** Plain text body. HTML is a later addition if ever needed. */
  body: string;
  /** Ties the send to its originating challenge so a retry is a no-op. */
  idempotencyKey: string;
}

export interface EmailSendResult {
  providerMessageId: string;
  status: 'sent' | 'failed';
  error?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(request: EmailSendRequest): Promise<EmailSendResult>;
}
