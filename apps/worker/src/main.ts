import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { validateEnv } from '@akabbo/config';
import { flushSentry, initSentry } from '@akabbo/observability';
import { WorkerModule } from './worker.module';

/**
 * Worker process entrypoint.
 *
 * Runs as a Nest application context (no HTTP server) — it drains work and runs
 * schedules, it does not serve requests. Shutdown hooks ensure the heartbeat
 * timer and DB connection close cleanly on SIGTERM (Cloud Run sends SIGTERM).
 */
async function bootstrap(): Promise<void> {
  const env = validateEnv();

  initSentry({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    role: 'worker',
  });

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(PinoLogger));
  app.enableShutdownHooks();

  const logger = app.get(PinoLogger);
  logger.log(`Akabbo worker started (env=${env.NODE_ENV})`);
}

bootstrap().catch(async (err) => {
  console.error('Fatal: worker failed to start', err);
  await flushSentry();
  process.exit(1);
});
