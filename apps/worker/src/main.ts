import 'reflect-metadata';
import { createServer } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { validateEnv } from '@akabbo/config';
import { flushSentry, initSentry } from '@akabbo/observability';
import { WorkerModule } from './worker.module';

/**
 * Worker process entrypoint.
 *
 * Runs as a Nest application context — it drains work and runs schedules.
 * Binds a lightweight HTTP listener on process.env.PORT for Cloud Run container
 * port health probing. Shutdown hooks ensure clean termination on SIGTERM.
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

  // Cloud Run requires container processes deployed as services to bind to $PORT.
  const port = env.PORT ?? 8080;
  const healthServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', role: 'worker' }));
  });
  healthServer.listen(port, '0.0.0.0');

  const logger = app.get(PinoLogger);
  logger.log(`Akabbo worker started (env=${env.NODE_ENV}, port=${port})`);
}

bootstrap().catch(async (err) => {
  console.error('Fatal: worker failed to start', err);
  await flushSentry();
  process.exit(1);
});
