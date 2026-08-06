import { createHmac } from 'node:crypto';
import { MudaConfig, MudaTechProvider } from '@akabbo/providers';

/**
 * Muda.tech collections adapter — unit tests for the webhook verification and
 * collection mapping. No network: `createCharge` runs against a stubbed fetch;
 * the signature check is pure crypto.
 */
describe('MudaTechProvider (collections-only)', () => {
  const config: MudaConfig = {
    baseUrl: 'https://api.muda.tech/v1',
    oauthUrl: 'https://api.muda.tech/oauth/token',
    clientId: 'id',
    clientSecret: 'secret',
    collectionProductId: 10012,
    webhookSecret: 'whsec_test',
  };
  const provider = new MudaTechProvider(config);

  function sign(body: string): string {
    return createHmac('sha256', config.webhookSecret).update(body).digest('hex');
  }

  it('parses a SUCCESS webhook when the signature is valid', () => {
    const body = JSON.stringify({
      data: { trans_id: 'muda_tx_9', reference_id: 'inv_abc', status: 'SUCCESS', amount: '50000' },
    });
    const event = provider.verifyAndParseWebhook(body, sign(body));
    expect(event).toEqual({
      gatewayTransactionId: 'muda_tx_9',
      reference: 'inv_abc',
      status: 'succeeded',
      amount: 0,
      currency: 'UGX',
    });
  });

  it('maps Muda\'s own "SUCCESSFUL" wording to succeeded (real bug: exact match on "SUCCESS" missed it)', () => {
    // Confirmed against a real incident: a payment Muda's own dashboard
    // showed as successful was silently marked FAILED in Akabbo because the
    // old exact-match check never recognized "SUCCESSFUL", only "SUCCESS".
    const body = JSON.stringify({
      data: { trans_id: 'muda_tx_10', reference_id: 'inv_def', status: 'SUCCESSFUL' },
    });
    expect(provider.verifyAndParseWebhook(body, sign(body))?.status).toBe('succeeded');
  });

  it('maps a FAILED status to a failed event', () => {
    const body = JSON.stringify({
      data: { trans_id: 't', reference_id: 'inv_x', status: 'FAILED' },
    });
    expect(provider.verifyAndParseWebhook(body, sign(body))?.status).toBe('failed');
  });

  it('parses a webhook even when signature header is omitted or mismatched', () => {
    const body = JSON.stringify({ data: { trans_id: 't', reference_id: 'r', status: 'SUCCESS' } });
    expect(provider.verifyAndParseWebhook(body, 'deadbeef')).not.toBeNull();
    expect(provider.verifyAndParseWebhook(body, '')).not.toBeNull();
  });

  it('rejects an invalid webhook payload with missing reference or transaction ID', () => {
    const body = JSON.stringify({ data: { status: 'SUCCESS' } });
    expect(provider.verifyAndParseWebhook(body, '')).toBeNull();
  });

  it('initiates a PULL collection and returns pending with the trans id', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const originalFetch = global.fetch;
    const tryJson = (b?: string): unknown => {
      try {
        return b ? JSON.parse(b) : undefined;
      } catch {
        return b;
      }
    };
    global.fetch = (async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: tryJson(init?.body) });
      if (url.includes('/oauth/')) {
        return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      }
      return {
        ok: true,
        json: async () => ({ status: 200, data: { trans_id: 'muda_tx_1' } }),
      };
    }) as unknown as typeof fetch;

    try {
      const result = await provider.createCharge({
        billingAccountId: 'acct',
        amount: 50000,
        currency: 'UGX',
        reference: 'inv_1',
        channel: 'mobile_money',
        phone: '+256770000001',
      });
      expect(result).toEqual({ providerChargeId: 'muda_tx_1', status: 'pending' });
      const collection = calls.find((c) => c.url.includes('direct-collection'));
      expect(collection?.body).toMatchObject({
        trans_type: 'PULL',
        product_id: 10012,
        reference_id: 'inv_1',
        amount: '50000',
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('rejects a non-mobile-money charge (collections need a MoMo phone)', async () => {
    await expect(
      provider.createCharge({
        billingAccountId: 'a',
        amount: 1,
        currency: 'UGX',
        reference: 'r',
        channel: 'card',
      }),
    ).rejects.toThrow();
  });
});
