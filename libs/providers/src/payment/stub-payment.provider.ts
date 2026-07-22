import { Injectable } from '@nestjs/common';
import { ProviderNotImplementedError } from '../provider.errors';
import {
  CreateChargeRequest,
  CreateChargeResult,
  PaymentProvider,
  PaymentWebhookEvent,
} from './payment.provider';

/** Phase 0 stub — fails loud if invoked. Real adapter: Phase 5. */
@Injectable()
export class StubPaymentProvider implements PaymentProvider {
  readonly name = 'stub';

  createCharge(_request: CreateChargeRequest): Promise<CreateChargeResult> {
    throw new ProviderNotImplementedError('PaymentProvider', 'createCharge', 'Phase 5');
  }

  verifyAndParseWebhook(
    _rawBody: string | Buffer,
    _signatureHeader: string,
  ): PaymentWebhookEvent | null {
    throw new ProviderNotImplementedError('PaymentProvider', 'verifyAndParseWebhook', 'Phase 5');
  }
}
