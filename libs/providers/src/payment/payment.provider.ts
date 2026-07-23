/**
 * Payment provider interface (Phase 5).
 *
 * Akabbo NEVER holds contribution funds (blueprint §2.3). This provider only
 * collects Akabbo's own SaaS fees (event packs, SMS top-ups, subscriptions).
 * Flutterwave is primary, Pesapal the failover. Webhooks are the SOURCE OF
 * TRUTH for grants — the app never marks a plan active from the client — and
 * webhook handling is idempotent on the gateway transaction id (metering §7.4).
 */

export interface CreateChargeRequest {
  billingAccountId: string;
  /** Minor units (e.g. UGX has none; still integer to avoid float money). */
  amount: number;
  currency: string;
  /** Our reference, echoed back on the webhook for idempotent reconciliation. */
  reference: string;
  channel: 'mobile_money' | 'card';
  /** The payer's MoMo number (required for `mobile_money` — the wallet charged). */
  phone?: string;
  description?: string;
}

export interface CreateChargeResult {
  providerChargeId: string;
  /** Redirect/collection URL or MoMo prompt reference. */
  authorizationUrl?: string;
  status: 'pending' | 'succeeded' | 'failed';
  message?: string;
}

export interface PaymentWebhookEvent {
  gatewayTransactionId: string;
  reference: string;
  status: 'succeeded' | 'failed';
  amount: number;
  currency: string;
}

export interface PaymentProvider {
  createCharge(request: CreateChargeRequest): Promise<CreateChargeResult>;
  /**
   * Verify a webhook's authenticity (signature) and parse it. Returns null if
   * the signature is invalid — callers MUST treat null as "reject", never as
   * "assume valid".
   */
  verifyAndParseWebhook(
    rawBody: string | Buffer,
    signatureHeader: string,
  ): PaymentWebhookEvent | null;
}
