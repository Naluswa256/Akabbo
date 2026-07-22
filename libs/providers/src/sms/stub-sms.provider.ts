import { Injectable } from '@nestjs/common';
import { ProviderNotImplementedError } from '../provider.errors';
import { SmsProvider, SmsSendRequest, SmsSendResult } from './sms.provider';

/** Phase 0 stub — fails loud if invoked. Real adapter: Phase 3. */
@Injectable()
export class StubSmsProvider implements SmsProvider {
  readonly name = 'stub';

  send(_request: SmsSendRequest): Promise<SmsSendResult> {
    throw new ProviderNotImplementedError('SmsProvider', 'send', 'Phase 3');
  }

  sendBulk(_requests: SmsSendRequest[]): Promise<SmsSendResult[]> {
    throw new ProviderNotImplementedError('SmsProvider', 'sendBulk', 'Phase 3');
  }
}
