import { initSentry, __resetSentryForTests } from './sentry';

describe('initSentry', () => {
  beforeEach(() => __resetSentryForTests());

  it('is a no-op (returns false) when DSN is blank', () => {
    const enabled = initSentry({
      dsn: '',
      environment: 'test',
      tracesSampleRate: 0,
      role: 'api',
    });
    expect(enabled).toBe(false);
  });

  it('enables (returns true) when a DSN is provided', () => {
    const enabled = initSentry({
      dsn: 'https://examplePublicKey@o0.ingest.sentry.io/0',
      environment: 'test',
      tracesSampleRate: 0,
      role: 'worker',
    });
    expect(enabled).toBe(true);
  });
});
