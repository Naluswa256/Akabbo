import { ProviderNotImplementedError } from './provider.errors';
import { StubLlmProvider } from './llm/stub-llm.provider';
import { StubSmsProvider } from './sms/stub-sms.provider';
import { StubPaymentProvider } from './payment/stub-payment.provider';
import { StubStorageProvider } from './storage/stub-storage.provider';
import { StubAuthProvider } from './auth/stub-auth.provider';

/**
 * Phase 0 invariant: stub providers must FAIL LOUD, never return fake success.
 * A silent stub "SMS sent" or "payment ok" would be a dangerous illusion.
 *
 * The stubs throw synchronously (before any real work), so we assert the throw
 * directly rather than via promise rejection.
 */
describe('Provider stubs fail loud (Phase 0)', () => {
  it('StubLlmProvider.complete throws NotImplemented', () => {
    expect(() => new StubLlmProvider().complete({ messages: [] })).toThrow(
      ProviderNotImplementedError,
    );
  });

  it('StubSmsProvider.send throws NotImplemented', () => {
    expect(() =>
      new StubSmsProvider().send({ to: '+256700000000', body: 'x', idempotencyKey: 'k' }),
    ).toThrow(ProviderNotImplementedError);
  });

  it('StubPaymentProvider.createCharge throws NotImplemented', () => {
    expect(() =>
      new StubPaymentProvider().createCharge({
        billingAccountId: 'a',
        amount: 50000,
        currency: 'UGX',
        reference: 'r',
        channel: 'mobile_money',
      }),
    ).toThrow(ProviderNotImplementedError);
  });

  it('StubPaymentProvider.verifyAndParseWebhook throws NotImplemented', () => {
    expect(() => new StubPaymentProvider().verifyAndParseWebhook('{}', 'sig')).toThrow(
      ProviderNotImplementedError,
    );
  });

  it('StubStorageProvider.putObject throws NotImplemented', () => {
    expect(() =>
      new StubStorageProvider().putObject({
        key: 'k',
        body: Buffer.from(''),
        contentType: 'image/png',
      }),
    ).toThrow(ProviderNotImplementedError);
  });

  it('StubAuthProvider.verifyAccessToken throws NotImplemented', () => {
    expect(() => new StubAuthProvider().verifyAccessToken('tok')).toThrow(
      ProviderNotImplementedError,
    );
  });
});
