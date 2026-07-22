import { Logger } from '@nestjs/common';
import { SmsProvider, SmsSendRequest, SmsSendResult } from './sms.provider';

export interface UgSmsConfig {
  baseUrl: string;
  apiKey: string;
  senderId: string;
}

interface UgSmsBulkResponse {
  success: boolean;
  message?: string;
  data?: {
    successful_messages?: Array<{ index: number; number: string; number_of_messages?: number }>;
    failed_messages?: Array<{ index: number; number: string; error?: string }> | null;
  };
}

/**
 * UGSMS (ugsms.com) API v2 adapter — our primary SMS reach provider (metering
 * doc §6; SMS is the dominant cost + the margin engine). Behind the SmsProvider
 * seam so a failover provider slots in identically. Uses the bulk endpoint for
 * personalised reminders (one call, many recipients — the per-minute rate limit
 * makes per-message calls unworkable), authenticated with the `X-API-Key` header.
 *
 * Our credit ledger (billing) is the source of truth for what a send costs the
 * user; the provider's own balance is observability only.
 */
export class UgSmsProvider implements SmsProvider {
  readonly name = 'ugsms';
  private readonly logger = new Logger(UgSmsProvider.name);

  constructor(private readonly config: UgSmsConfig) {}

  /** Single send — delegates to the bulk path so there is one code path. */
  async send(request: SmsSendRequest): Promise<SmsSendResult> {
    const [result] = await this.sendBulk([request]);
    return result;
  }

  async sendBulk(requests: SmsSendRequest[]): Promise<SmsSendResult[]> {
    if (requests.length === 0) return [];
    const res = await fetch(`${this.config.baseUrl}/sms/send/bulk`, {
      method: 'POST',
      headers: { 'x-api-key': this.config.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: requests.map((r) => ({ number: toLocal(r.to), message_body: r.body })),
        sender_id: this.config.senderId,
        reference: requests[0]?.idempotencyKey,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as UgSmsBulkResponse;

    // Whole-request failure (auth, network, malformed) → every message failed.
    if (!res.ok || !body.data) {
      this.logger.error(`UGSMS bulk failed: HTTP ${res.status} ${body.message ?? ''}`);
      return requests.map(() => ({ providerMessageId: '', status: 'failed', segments: 1 }));
    }

    // Map per-message results back by index (default: failed).
    const results: SmsSendResult[] = requests.map(() => ({
      providerMessageId: '',
      status: 'failed' as const,
      segments: 1,
    }));
    for (const ok of body.data.successful_messages ?? []) {
      results[ok.index] = {
        providerMessageId: '',
        status: 'sent',
        segments: ok.number_of_messages ?? 1,
      };
    }
    for (const bad of body.data.failed_messages ?? []) {
      results[bad.index] = { providerMessageId: '', status: 'failed', segments: 1 };
    }
    return results;
  }

  async balance(): Promise<{ balance: number; currency: string }> {
    const res = await fetch(`${this.config.baseUrl}/account/balance`, {
      headers: { 'x-api-key': this.config.apiKey },
    });
    if (!res.ok) throw new Error(`UGSMS balance failed (${res.status})`);
    const body = (await res.json()) as { data?: { balance?: number; currency?: string } };
    return { balance: body.data?.balance ?? 0, currency: body.data?.currency ?? 'UGX' };
  }
}

/** UGSMS expects local Uganda format (0XXXXXXXXX); normalise from E.164. */
function toLocal(phone: string): string {
  return phone.replace(/^\+?256/, '0');
}
