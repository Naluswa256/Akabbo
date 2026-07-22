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
