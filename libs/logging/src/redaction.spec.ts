import { REDACT_PATHS } from './redaction';

describe('REDACT_PATHS (no PII in logs — CLAUDE.md §3.10)', () => {
  it('redacts phone numbers, OTPs, and amounts wherever they appear', () => {
    expect(REDACT_PATHS).toEqual(
      expect.arrayContaining(['*.phone', '*.phoneNumber', '*.msisdn', '*.otp', '*.amount']),
    );
  });

  it('redacts auth material on requests', () => {
    expect(REDACT_PATHS).toEqual(
      expect.arrayContaining(['req.headers.authorization', 'req.headers.cookie']),
    );
  });
});
