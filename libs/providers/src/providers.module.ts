import { Global, Module, Provider } from '@nestjs/common';
import { AppConfigService } from '@akabbo/config';
import {
  EMAIL_PROVIDER,
  LLM_PROVIDER,
  PAYMENT_PROVIDER,
  SEARCH_PROVIDER,
  SMS_PROVIDER,
  STORAGE_PROVIDER,
} from './tokens';
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
import { MudaTechProvider, normalizeMudaOauthUrl } from './payment/muda-payment.provider';
import { StorageProvider } from './storage/storage.provider';
import { StubStorageProvider } from './storage/stub-storage.provider';
import { LocalStorageProvider } from './storage/local-storage.provider';
import { GcsStorageProvider } from './storage/gcs-storage.provider';
import { SearchProvider } from './search/search.provider';
import { StubSearchProvider } from './search/stub-search.provider';
import { TavilySearchProvider } from './search/tavily-search.provider';
import { EmailProvider } from './email/email.provider';
import { StubEmailProvider } from './email/stub-email.provider';
import { TwilioEmailProvider } from './email/twilio-email.provider';

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
  const baseUrl = config.get('MUDA_BASE_URL') || 'https://api.muda.tech/v1';
  const oauthUrl = normalizeMudaOauthUrl(config.get('MUDA_OAUTH_URL'), baseUrl);
  if (!clientId || !clientSecret) return new StubPaymentProvider();
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

/**
 * Selects the web-search provider (budget intelligence). 'tavily' wires the
 * real adapter when its API key is present; otherwise the stub. This is the
 * one provider seam that reaches the open internet on the model's behalf, so
 * it stays behind the exact same swappable-by-config discipline as every
 * other vendor here.
 */
function buildSearchProvider(config: AppConfigService): SearchProvider {
  if (config.get('SEARCH_PROVIDER') !== 'tavily') return new StubSearchProvider();
  const apiKey = config.get('SEARCH_API_KEY');
  if (!apiKey) return new StubSearchProvider();
  return new TavilySearchProvider({ apiKey });
}

/**
 * Selects the email provider (email OTP auth). 'twilio' wires the real
 * Twilio Email API adapter when the account credentials are present;
 * otherwise the stub.
 */
function buildEmailProvider(config: AppConfigService): EmailProvider {
  if (config.get('EMAIL_PROVIDER') !== 'twilio') return new StubEmailProvider();
  const accountSid = config.get('TWILIO_ACCOUNT_SID');
  const authToken = config.get('TWILIO_AUTH_TOKEN');
  if (!accountSid || !authToken) return new StubEmailProvider();
  // TEMPORARY fallback: the custom domain sender (noreply@em9096.linktrust.app)
  // is DNS-authenticated but still rejected by Twilio account-side (confirmed
  // via direct API testing, 2026-08-03) — only the account's auto-provisioned
  // sender identity ({accountSid}@linktrust.app) is accepted today. Derived
  // here (never committed as a literal) so EMAIL_FROM_ADDRESS can stay unset
  // until the custom domain clears; set it explicitly to override.
  const fromAddress = config.get('EMAIL_FROM_ADDRESS') || `${accountSid}@linktrust.app`;
  return new TwilioEmailProvider({ accountSid, authToken, fromAddress });
}

const providerBindings: Provider[] = [
  { provide: LLM_PROVIDER, useFactory: buildLlmProvider, inject: [AppConfigService] },
  { provide: SMS_PROVIDER, useFactory: buildSmsProvider, inject: [AppConfigService] },
  { provide: PAYMENT_PROVIDER, useFactory: buildPaymentProvider, inject: [AppConfigService] },
  { provide: STORAGE_PROVIDER, useFactory: buildStorageProvider, inject: [AppConfigService] },
  { provide: SEARCH_PROVIDER, useFactory: buildSearchProvider, inject: [AppConfigService] },
  { provide: EMAIL_PROVIDER, useFactory: buildEmailProvider, inject: [AppConfigService] },
];

@Global()
@Module({
  providers: providerBindings,
  exports: providerBindings.map((p) => (p as { provide: symbol }).provide),
})
export class ProvidersModule {}
