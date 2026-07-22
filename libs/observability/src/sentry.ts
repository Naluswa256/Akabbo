import * as Sentry from '@sentry/node';

export interface SentryInitOptions {
  dsn: string;
  environment: string;
  release?: string;
  tracesSampleRate: number;
  role: 'api' | 'worker';
}

let initialized = false;

/**
 * Initialise Sentry error reporting.
 *
 * No-op when the DSN is blank (the Phase 0 / local default) so the app runs
 * cleanly without a Sentry account. Must be called as early as possible in
 * `main.ts`, before the Nest app is created, so instrumentation wraps startup.
 *
 * Returns true if Sentry was actually enabled.
 */
export function initSentry(opts: SentryInitOptions): boolean {
  if (!opts.dsn) {
    return false;
  }
  if (initialized) {
    return true;
  }

  Sentry.init({
    dsn: opts.dsn,
    environment: opts.environment,
    release: opts.release,
    tracesSampleRate: opts.tracesSampleRate,
    initialScope: { tags: { role: opts.role } },
    // Defence-in-depth against PII leaking through error payloads
    // (CLAUDE.md §3.10). We never send request bodies or user IP.
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
      }
      return event;
    },
  });

  initialized = true;
  return true;
}

export function captureException(err: unknown): void {
  if (initialized) {
    Sentry.captureException(err);
  }
}

/** Flush buffered events before the process exits. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (initialized) {
    await Sentry.flush(timeoutMs);
  }
}

/** Test-only reset of module state. */
export function __resetSentryForTests(): void {
  initialized = false;
}
