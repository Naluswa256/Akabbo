/**
 * PII redaction paths for structured logs (CLAUDE.md invariant §3.10:
 * "No PII in logs. Phone numbers and amounts are sensitive.").
 *
 * These are pino `redact` paths. They are applied to every log record before
 * it is written. When later phases introduce request/response bodies carrying
 * contributor data, extend this list rather than logging raw payloads.
 *
 * Redaction is defence-in-depth, not a licence to log PII: the rule remains
 * "don't put phone numbers or amounts into log messages in the first place".
 */
export const REDACT_PATHS: string[] = [
  // Auth material
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  // PII that must never surface even if accidentally attached to a log object
  '*.phone',
  '*.phoneNumber',
  '*.msisdn',
  '*.otp',
  '*.password',
  '*.amount',
  '*.pin',
  'req.body.phone',
  'req.body.phoneNumber',
  'req.body.otp',
  'req.body.amount',
];

export const REDACT_CENSOR = '[redacted]';
