import { Logger } from '@nestjs/common';
import { EmailProvider, EmailSendRequest, EmailSendResult } from './email.provider';

export interface SendGridEmailConfig {
  apiKey: string;
  fromAddress: string;
}

/**
 * SendGrid Mail Send v3 API adapter (api.sendgrid.com/v3/mail/send).
 *
 * Auth: Bearer API key (the key created in SendGrid Console → Settings →
 * API Keys). Completely distinct from the Twilio comms.twilio.com Email API —
 * different base URL, different auth scheme (Bearer vs Basic), different
 * request shape. Verified against
 * https://docs.sendgrid.com/api-reference/mail-send/mail-send
 * before writing this.
 *
 * The verified sender used in production is noreply@linktrust.app,
 * authenticated via SendGrid's domain verification (Single Sender Verification
 * on the Sender Authentication page — already shows ✓ Verified).
 *
 * Fire-and-forget for OTP purposes: a 202 means SendGrid accepted the send,
 * not guaranteed delivery. Same contract as the SMS OTP path.
 */
export class SendGridEmailProvider implements EmailProvider {
  readonly name = 'sendgrid';
  private readonly logger = new Logger(SendGridEmailProvider.name);

  constructor(private readonly config: SendGridEmailConfig) {}

  async send(request: EmailSendRequest): Promise<EmailSendResult> {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: { email: this.config.fromAddress },
        personalizations: [{ to: [{ email: request.to }] }],
        subject: request.subject,
        content: [
          { type: 'text/plain', value: request.body },
          { type: 'text/html', value: toHtml(request.body) },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.warn(
        `SendGrid email send failed (HTTP ${res.status}): ${detail.slice(0, 300)}`,
      );
      return { providerMessageId: '', status: 'failed', error: `HTTP ${res.status}` };
    }

    // SendGrid 202: message-id is in the X-Message-Id response header.
    const messageId = res.headers.get('x-message-id') ?? '';
    return { providerMessageId: messageId, status: 'sent' };
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
