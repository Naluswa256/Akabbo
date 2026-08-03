import { Logger } from '@nestjs/common';
import { EmailProvider, EmailSendRequest, EmailSendResult } from './email.provider';

export interface TwilioEmailConfig {
  accountSid: string;
  authToken: string;
  fromAddress: string;
}

/**
 * Twilio's own Email API (comms.twilio.com) — distinct from the legacy
 * SendGrid v3 Mail Send API (api.sendgrid.com): different base URL, Basic
 * auth with Account SID/Auth Token (the standard Twilio credential pair,
 * same shape as their SMS/Voice APIs) rather than a bearer API key, and an
 * async accept-then-track response instead of a synchronous one. Verified
 * against https://www.twilio.com/docs/email/api/mail-send before writing
 * this, not assumed. Domain authentication (the verified subdomain) is
 * configured entirely on Twilio's side; this adapter only needs the
 * account credentials and the "from" address that domain authorizes.
 *
 * Fire-and-forget for OTP purposes, same as the SMS OTP path: a 202 means
 * Twilio accepted the send, not that it was delivered. We don't poll
 * `operationLocation` for final status — the existing SMS OTP flow doesn't
 * track delivery status either, and OTP already has its own success signal
 * (the user comes back with the code).
 */
export class TwilioEmailProvider implements EmailProvider {
  readonly name = 'twilio';
  private readonly logger = new Logger(TwilioEmailProvider.name);

  constructor(private readonly config: TwilioEmailConfig) {}

  async send(request: EmailSendRequest): Promise<EmailSendResult> {
    const basicAuth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString(
      'base64',
    );
    const res = await fetch('https://comms.twilio.com/v1/Emails', {
      method: 'POST',
      headers: {
        authorization: `Basic ${basicAuth}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: { address: this.config.fromAddress },
        to: [{ address: request.to }],
        // Confirmed via live testing: the API rejects a content object that
        // has only `text` (400 "Invalid value provided for field 'content'")
        // — `html` is required. Sending both is accepted and is the safer
        // choice for plain-text-only email clients.
        content: { subject: request.subject, text: request.body, html: toHtml(request.body) },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.warn(`Twilio email send failed (HTTP ${res.status}): ${detail.slice(0, 300)}`);
      return { providerMessageId: '', status: 'failed', error: `HTTP ${res.status}` };
    }
    const body = (await res.json().catch(() => ({}))) as { operationId?: string };
    return { providerMessageId: body.operationId ?? '', status: 'sent' };
  }
}

/** Minimal plain-text → HTML conversion for a one-line OTP message. */
function toHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<p>${escaped.replace(/\n/g, '<br>')}</p>`;
}
