import { Injectable } from '@nestjs/common';
import { Env } from './env.schema';

/**
 * Typed, read-only accessor for validated configuration.
 *
 * Domain and infrastructure code depends on this, never on `process.env`
 * directly — that keeps env access in one validated place and makes config
 * trivially mockable in tests.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly env: Env) {}

  get all(): Readonly<Env> {
    return this.env;
  }

  get<K extends keyof Env>(key: K): Env[K] {
    return this.env[key];
  }

  get nodeEnv(): Env['NODE_ENV'] {
    return this.env.NODE_ENV;
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get isTest(): boolean {
    return this.env.NODE_ENV === 'test';
  }

  get appRole(): Env['APP_ROLE'] {
    return this.env.APP_ROLE;
  }

  get port(): number {
    return this.env.PORT;
  }

  get logLevel(): Env['LOG_LEVEL'] {
    return this.env.LOG_LEVEL;
  }

  get databaseUrl(): string {
    return this.env.DATABASE_URL;
  }

  get sentryDsn(): string {
    return this.env.SENTRY_DSN;
  }

  get sentryTracesSampleRate(): number {
    return this.env.SENTRY_TRACES_SAMPLE_RATE;
  }

  get workerHeartbeatMs(): number {
    return this.env.WORKER_HEARTBEAT_MS;
  }
}
