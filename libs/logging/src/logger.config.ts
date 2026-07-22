import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { REDACT_CENSOR, REDACT_PATHS } from './redaction';

export interface LoggerOptions {
  role: 'api' | 'worker';
  level: string;
  /** Pretty-print for local dev; JSON everywhere else. */
  pretty: boolean;
}

/**
 * Build the nestjs-pino configuration.
 *
 * Production emits single-line structured JSON (one object per log line) with
 * PII redaction applied. Development can pretty-print for readability. Every
 * HTTP log line carries a request id for correlation.
 */
export function buildLoggerParams(opts: LoggerOptions): Params {
  return {
    pinoHttp: {
      level: opts.level,
      base: { role: opts.role },
      redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
      // Correlate every request; honour an inbound id if a proxy set one.
      genReqId: (req: IncomingMessage, res: ServerResponse): string => {
        const existing =
          (req.headers['x-request-id'] as string | undefined) ??
          (req.headers['x-cloud-trace-context'] as string | undefined);
        const id = existing ?? randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      // Keep noise down; health checks are frequent and boring.
      autoLogging: {
        ignore: (req: IncomingMessage) => req.url === '/health',
      },
      transport: opts.pretty
        ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
        : undefined,
    },
  };
}
