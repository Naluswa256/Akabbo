import { Global, Module, Provider } from '@nestjs/common';
import { AppConfigService } from '@akabbo/config';
import { LLM_PROVIDER, PAYMENT_PROVIDER, SMS_PROVIDER, STORAGE_PROVIDER } from './tokens';
import { LlmProvider } from './llm/llm.provider';
import { StubLlmProvider } from './llm/stub-llm.provider';
import { GeminiLlmProvider } from './llm/gemini-llm.provider';
import { AnthropicLlmProvider } from './llm/anthropic-llm.provider';
import { FallbackLlmProvider } from './llm/fallback-llm.provider';
import { SmsProvider } from './sms/sms.provider';
import { StubSmsProvider } from './sms/stub-sms.provider';
import { UgSmsProvider } from './sms/ugsms.provider';
import { PaymentProvider } from './payment/payment.provider';
import { StubPaymentProvider } from './payment/stub-payment.provider';
import { MudaTechProvider } from './payment/muda-payment.provider';
import { StorageProvider } from './storage/storage.provider';
import { StubStorageProvider } from './storage/stub-storage.provider';
import { LocalStorageProvider } from './storage/local-storage.provider';
import { GcsStorageProvider } from './storage/gcs-storage.provider';

/**
 * Selects the real LLM provider from the env selector (Phase 2). Default 'stub'
 * keeps the app bootable with no key; 'gemini' wires the real Gemini adapter,
 * with the Claude adapter appended as a fallback when ANTHROPIC_API_KEY is set.
 * This factory is the ONE place vendor selection happens; domain code injects
 * the LLM_PROVIDER token only.
 */
function buildLlmProvider(config: AppConfigService): LlmProvider {
  const selector = config.get('LLM_PROVIDER');
  if (selector !== 'gemini') return new StubLlmProvider();

  const geminiKey = config.get('GEMINI_API_KEY');
  const anthropicKey = config.get('ANTHROPIC_API_KEY');
  const chain: LlmProvider[] = [];
  if (geminiKey) chain.push(new GeminiLlmProvider(geminiKey, config.get('GEMINI_MODEL')));
  if (anthropicKey)
    chain.push(new AnthropicLlmProvider(anthropicKey, config.get('ANTHROPIC_MODEL')));
  if (chain.length === 0) return new StubLlmProvider();
  return chain.length === 1 ? chain[0] : new FallbackLlmProvider(chain);
}

/**
 * Binds the external provider tokens. AUTH_PROVIDER is bound by IdentityModule
 * (real from Phase 1). LLM is real (or stub) via the factory above; SMS,
 * Storage, Payments stay stub until their phases (3/4/5).
 */
/**
 * Selects the storage provider. 'local' (default) is a working implementation
 * behind the same seam Cloudflare R2 uses in production — so the document
 * pipeline runs end-to-end without cloud credentials, and going live is a
 * config change (blueprint §5).
 */
/**
 * Selects the payment provider (metering §8). 'muda' wires the real Muda.tech
 * MoMo collections adapter when its OAuth creds are present; otherwise the stub.
 * Collections only — Akabbo never pays out (§8). Flutterwave/Pesapal would slot
 * in here identically.
 */
/**
 * Selects the SMS provider (metering §6). 'ugsms' wires the real UGSMS v2
 * adapter when its API key is present; otherwise the stub. A failover provider
 * would slot in here identically behind the same seam.
 */
function buildSmsProvider(config: AppConfigService): SmsProvider {
  if (config.get('SMS_PROVIDER') !== 'ugsms') return new StubSmsProvider();
  const apiKey = config.get('UGSMS_API_KEY');
  if (!apiKey) return new StubSmsProvider();
  return new UgSmsProvider({
    baseUrl: config.get('UGSMS_BASE_URL'),
    apiKey,
    senderId: config.get('UGSMS_SENDER_ID'),
  });
}

function buildPaymentProvider(config: AppConfigService): PaymentProvider {
  if (config.get('PAYMENT_PROVIDER') !== 'muda') return new StubPaymentProvider();
  const clientId = config.get('MUDA_CLIENT_ID');
  const clientSecret = config.get('MUDA_CLIENT_SECRET');
  const oauthUrl = config.get('MUDA_OAUTH_URL') || `${config.get('MUDA_BASE_URL')}/clients/oauth/token`;
  if (!clientId || !clientSecret || !oauthUrl) return new StubPaymentProvider();
  return new MudaTechProvider({
    baseUrl: config.get('MUDA_BASE_URL'),
    oauthUrl,
    clientId,
    clientSecret,
    collectionProductId: config.get('MUDA_COLLECTION_PRODUCT_ID'),
    webhookSecret: config.get('MUDA_WEBHOOK_SECRET'),
  });
}

function buildStorageProvider(config: AppConfigService): StorageProvider {
  const selector = config.get('STORAGE_PROVIDER');
  if (selector === 'gcs') {
    return new GcsStorageProvider({
      bucket: config.get('GCS_BUCKET'),
      serviceAccountEmail: config.get('GCS_SERVICE_ACCOUNT_EMAIL'),
    });
  }
  if (selector === 'local') {
    return new LocalStorageProvider(
      config.get('LOCAL_STORAGE_DIR'),
      config.get('JWT_SECRET'), // signing secret for expiring object URLs
    );
  }
  return new StubStorageProvider();
}

const providerBindings: Provider[] = [
  { provide: LLM_PROVIDER, useFactory: buildLlmProvider, inject: [AppConfigService] },
  { provide: SMS_PROVIDER, useFactory: buildSmsProvider, inject: [AppConfigService] },
  { provide: PAYMENT_PROVIDER, useFactory: buildPaymentProvider, inject: [AppConfigService] },
  { provide: STORAGE_PROVIDER, useFactory: buildStorageProvider, inject: [AppConfigService] },
];

@Global()
@Module({
  providers: providerBindings,
  exports: providerBindings.map((p) => (p as { provide: symbol }).provide),
})
export class ProvidersModule {}
