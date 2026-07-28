import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { validateEnv } from '@akabbo/config';
import { flushSentry, initSentry } from '@akabbo/observability';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

// Money is BigInt in the domain; make it JSON-serialisable at the HTTP edge so
// responses render amounts as decimal strings rather than throwing.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint): string {
  return this.toString();
};

/**
 * API process entrypoint.
 *
 * Order matters: validate env (fail-closed) → init Sentry (wrap startup) →
 * create the Nest app with our structured logger → listen. Cloud Run injects
 * PORT and expects the process to bind 0.0.0.0:$PORT quickly.
 */
async function bootstrap(): Promise<void> {
  const env = validateEnv();

  initSentry({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    role: 'api',
  });

  // rawBody: the payment webhook verifies an HMAC over the exact bytes received.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });

  // Increase HTTP body limit (up to 15MB) for base64 document/image uploads
  app.use(json({ limit: '15mb' }));
  app.use(urlencoded({ limit: '15mb', extended: true }));

  // Enable CORS so cross-origin frontend requests (e.g. localhost:3000) pass OPTIONS preflight.
  app.enableCors({
    origin: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    allowedHeaders:
      'Content-Type, Accept, Authorization, X-Requested-With, x-muda-signature, x-akabbo-access-token, x-akabbo-admin-secret',
  });

  app.useLogger(app.get(PinoLogger));
  app.enableShutdownHooks();
  // Validate & strip every incoming DTO; reject unknown fields (fail closed).
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  const logger = app.get(PinoLogger);
  await app.listen(env.PORT, '0.0.0.0');
  logger.log(`Akabbo API listening on :${env.PORT} (env=${env.NODE_ENV})`);
}

bootstrap().catch(async (err) => {
  console.error('Fatal: API failed to start', err);
  await flushSentry();
  process.exit(1);
});
