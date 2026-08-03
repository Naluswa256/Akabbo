import { Injectable } from '@nestjs/common';
import { ProviderNotImplementedError } from '../provider.errors';
import { EmailProvider, EmailSendRequest, EmailSendResult } from './email.provider';

/** Default stub — fails loud if invoked. Real adapter activates only when
 *  EMAIL_PROVIDER=twilio + TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/EMAIL_FROM_ADDRESS
 *  are configured (see providers.module.ts). */
@Injectable()
export class StubEmailProvider implements EmailProvider {
  readonly name = 'stub';

  send(_request: EmailSendRequest): Promise<EmailSendResult> {
    throw new ProviderNotImplementedError(
      'EmailProvider',
      'send',
      'email OTP auth (set EMAIL_PROVIDER=twilio + TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/EMAIL_FROM_ADDRESS)',
    );
  }
}
