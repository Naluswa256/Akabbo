/**
 * DI tokens for the provider interfaces we own.
 *
 * Every external dependency (LLM, SMS, payments, storage, auth) is injected by
 * token, never by a concrete vendor class — this is the "provider-interface
 * discipline" (CLAUDE.md §2.1) that keeps vendor SDKs out of domain code and
 * makes each dependency swappable via configuration.
 */
export const LLM_PROVIDER = Symbol('LlmProvider');
export const SMS_PROVIDER = Symbol('SmsProvider');
export const PAYMENT_PROVIDER = Symbol('PaymentProvider');
export const STORAGE_PROVIDER = Symbol('StorageProvider');
export const AUTH_PROVIDER = Symbol('AuthProvider');
