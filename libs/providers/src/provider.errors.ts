/**
 * Thrown by a stub provider when a method is invoked before its real
 * implementation exists (Phase 0 ships stubs only).
 *
 * Stubs fail LOUD rather than returning fake success. A silent stub SMS "send"
 * or "payment ok" would be a dangerous illusion — this error guarantees that if
 * any code path reaches a not-yet-built provider, it stops immediately instead
 * of pretending the side effect happened.
 */
export class ProviderNotImplementedError extends Error {
  constructor(provider: string, method: string, phase: string) {
    super(
      `${provider}.${method}() is a Phase 0 stub and is not implemented yet ` +
        `(real implementation arrives in ${phase}).`,
    );
    this.name = 'ProviderNotImplementedError';
  }
}

/**
 * Thrown by an LLM provider when the API rate-limit or quota is exhausted and
 * all retry attempts have been spent.
 *
 * Distinguished from a generic Error so that callers (e.g. AssistantService)
 * can return a graceful "assistant is busy" user-facing message rather than a
 * hard failure, while still correctly refunding AI credits for the turn.
 */
export class LlmRateLimitedError extends Error {
  /** HTTP status that triggered the exhaustion (typically 429 or 503). */
  readonly status: number;

  constructor(status: number, detail?: string) {
    super(
      `LLM rate limit exhausted (HTTP ${status})${
        detail ? `: ${detail}` : ''
      } — all retry attempts spent.`,
    );
    this.name = 'LlmRateLimitedError';
    this.status = status;
  }
}
