/**
 * Redacts PII (Phone numbers, OTPs, Amounts, PINs) from prompt strings and tool calls
 * before writing to telemetry traces or synthesizing exemplars.
 * CLAUDE.md invariant §3.10: "No PII in logs/traces. Phone numbers and amounts are sensitive."
 */
export function redactPii(text: string | null | undefined): string {
  if (!text) return '';
  return text
    // International & Ugandan phone numbers: +2567... or 07... (9 to 12 digits)
    .replace(/(\+?256|0)[7-9]\d{8}/g, '[PHONE_REDACTED]')
    // Specific amounts with currency or suffixes: e.g. "UGX 25,000,000", "200k", "500,000"
    .replace(/\b(UGX\s*)?(\d{1,3}(,\d{3})+|\d+k|\d+m|\d{5,9})\b/gi, '[AMOUNT_REDACTED]')
    // OTPs / PINs: 6-digit codes
    .replace(/\b\d{6}\b/g, '[OTP_REDACTED]');
}
