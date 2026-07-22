import { createHmac, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  CreateChargeRequest,
  CreateChargeResult,
  PaymentProvider,
  PaymentWebhookEvent,
} from './payment.provider';

export interface MudaConfig {
  baseUrl: string;
  oauthUrl: string;
  clientId: string;
  clientSecret: string;
  collectionProductId: number;
  webhookSecret: string;
}

interface MudaCollectionResponse {
  status?: number;
  message?: string;
  data?: { trans_id?: string; transaction_id?: string; status?: string; reference_id?: string };
}

/**
 * Muda.tech Mobile Money adapter — COLLECTIONS ONLY (metering doc §8). Akabbo
 * never holds contributor funds and never pays anyone out, so this implements
 * only the PULL direct-collection for our own SaaS fees; the provider's PUSH
 * payout is deliberately omitted. Sits behind the `PaymentProvider` seam so
 * Flutterwave/Pesapal can slot in the same way.
 *
 * Auth is OAuth client-credentials (token cached until just before expiry).
 * Grants are applied from the webhook (verified + idempotent), never here.
 */
export class MudaTechProvider implements PaymentProvider {
  readonly name = 'muda';
  private readonly logger = new Logger(MudaTechProvider.name);
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: MudaConfig) {}

  /**
   * Initiate a direct-collection (PULL) — charges the payer's mobile wallet.
   * Returns `pending`: the payer approves the prompt on their phone, and the
   * final state arrives via {@link verifyAndParseWebhook}.
   */
  async createCharge(request: CreateChargeRequest): Promise<CreateChargeResult> {
    if (request.channel !== 'mobile_money' || !request.phone) {
      throw new Error('Muda collection requires a mobile_money channel and a payer phone');
    }
    const token = await this.getToken();
    const res = await fetch(`${this.config.baseUrl}/payment/direct-collection`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        product_id: this.config.collectionProductId,
        phone: request.phone,
        amount: String(request.amount),
        currency: request.currency,
        reference_id: request.reference,
        trans_type: 'PULL',
      }),
    });
    const body = (await res.json().catch(() => ({}))) as MudaCollectionResponse;

    // Muda may return HTTP 200 with a non-2xx status IN THE BODY.
    const bodyStatus = body.status;
    if (!res.ok || (typeof bodyStatus === 'number' && (bodyStatus < 200 || bodyStatus >= 300))) {
      const message = body.message ?? `HTTP ${res.status}`;
      this.logger.error(`Muda collection failed (ref=${request.reference}): ${message}`);
      return { providerChargeId: '', status: 'failed' };
    }

    const trans_id = body.data?.trans_id ?? body.data?.transaction_id ?? '';
    this.logger.log(`Muda collection submitted: trans_id=${trans_id} ref=${request.reference}`);
    return { providerChargeId: trans_id, status: 'pending' };
  }

  /**
   * Parse a Muda callback into our webhook event. Signature verification is optional
   * and non-blocking — if payload has valid reference and transaction IDs, it parses.
   */
  verifyAndParseWebhook(
    rawBody: string | Buffer,
    signatureHeader?: string,
  ): PaymentWebhookEvent | null {
    const raw = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    if (
      this.config.webhookSecret &&
      signatureHeader &&
      !this.verifySignature(raw, signatureHeader)
    ) {
      this.logger.warn('Muda webhook signature mismatch (proceeding with payload parsing)');
    }
    let parsed: MudaCollectionResponse;
    try {
      parsed = JSON.parse(raw) as MudaCollectionResponse;
    } catch {
      return null;
    }
    const data = parsed.data ?? (parsed as unknown as Record<string, unknown>);
    const reference =
      (data as { reference_id?: string; reference?: string }).reference_id ??
      (data as { reference?: string }).reference;
    const gatewayTransactionId =
      (data as { trans_id?: string; transaction_id?: string; id?: string }).trans_id ??
      (data as { transaction_id?: string }).transaction_id ??
      (data as { id?: string }).id;
    if (!reference || !gatewayTransactionId) return null;

    const raw_status = ((data as { status?: string }).status ?? parsed.status ?? '')
      .toString()
      .toUpperCase();
    const status: PaymentWebhookEvent['status'] =
      raw_status === 'SUCCESS' || raw_status === '200' || raw_status === 'COMPLETED'
        ? 'succeeded'
        : 'failed';
    return { gatewayTransactionId, reference, status, amount: 0, currency: 'UGX' };
  }

  private verifySignature(raw: string, header: string): boolean {
    if (!this.config.webhookSecret || !header) return false;
    const expected = createHmac('sha256', this.config.webhookSecret).update(raw).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(header);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** OAuth client-credentials token, cached until 60s before expiry. */
  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const res = await fetch(this.config.oauthUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }).toString(),
    });
    if (!res.ok) throw new Error(`Muda OAuth failed (${res.status})`);
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    const ttlMs = (json.expires_in ?? 3600) * 1000;
    this.token = { value: json.access_token, expiresAt: Date.now() + ttlMs - 60_000 };
    return this.token.value;
  }
}
