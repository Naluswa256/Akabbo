import { validateEnv } from './env.schema';

const VALID_DB =
  'postgresql://user:pass@ep-cool-name-pooler.eu-central-1.aws.neon.tech/akabbo?sslmode=require';

describe('validateEnv', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = validateEnv({ DATABASE_URL: VALID_DB } as NodeJS.ProcessEnv);

    expect(env.DATABASE_URL).toBe(VALID_DB);
    expect(env.NODE_ENV).toBe('development');
    expect(env.APP_ROLE).toBe('api');
    expect(env.PORT).toBe(8080);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.WORKER_HEARTBEAT_MS).toBe(15000);
    // External providers default to stub; auth is real from Phase 1.
    expect(env.LLM_PROVIDER).toBe('stub');
    expect(env.AUTH_PROVIDER).toBe('local');
  });

  it('coerces numeric string env vars into numbers', () => {
    const env = validateEnv({
      DATABASE_URL: VALID_DB,
      PORT: '3000',
      WORKER_HEARTBEAT_MS: '5000',
      SENTRY_TRACES_SAMPLE_RATE: '0.25',
    } as NodeJS.ProcessEnv);

    expect(env.PORT).toBe(3000);
    expect(env.WORKER_HEARTBEAT_MS).toBe(5000);
    expect(env.SENTRY_TRACES_SAMPLE_RATE).toBe(0.25);
  });

  it('fails closed when DATABASE_URL is missing', () => {
    expect(() => validateEnv({} as NodeJS.ProcessEnv)).toThrow(/Invalid environment configuration/);
  });

  it('fails closed when DATABASE_URL is not a postgres URL', () => {
    expect(() => validateEnv({ DATABASE_URL: 'mysql://nope' } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: VALID_DB,
        NODE_ENV: 'staging',
      } as NodeJS.ProcessEnv),
    ).toThrow(/NODE_ENV/);
  });

  it('rejects a sample rate outside 0..1', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: VALID_DB,
        SENTRY_TRACES_SAMPLE_RATE: '2',
      } as NodeJS.ProcessEnv),
    ).toThrow(/SENTRY_TRACES_SAMPLE_RATE/);
  });
});
