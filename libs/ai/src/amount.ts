/**
 * Parse a human money expression into integer minor units (BigInt).
 *
 * Handles the shapes people actually type/say in this market: "200k", "1.5m",
 * "500,000", "200000". UGX has no minor units, so the integer is the amount.
 * Returns null if the input isn't a recognisable amount (the caller then treats
 * the utterance as unparsed and may escalate to the LLM).
 */
export function parseAmountToMinorUnits(input: string): bigint | null {
  const cleaned = input.trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '');
  const match = cleaned.match(/^(?:ugx|usd|shs?|\$)?(\d+(?:\.\d+)?)(k|m)?$/i);
  if (!match) return null;

  const [, numStr, suffix] = match;
  const multiplier = suffix === 'k' ? 1000 : suffix === 'm' ? 1000000 : 1;
  const scaled = Number(numStr) * multiplier;
  if (!Number.isFinite(scaled) || scaled < 0) return null;
  // Amounts must be whole minor units (e.g. "1.5m" = 1_500_000 is fine, but
  // "1.2345k" = 1234.5 is not a valid integer amount).
  if (!Number.isInteger(scaled)) return null;
  return BigInt(scaled);
}

/**
 * Format integer minor units with thousands separators for human-facing AI
 * prose (tool-result messages, staged-action prompts). Display-only — never
 * use this for API/JSON money fields, which stay plain digit strings
 * (moneyToString) so the frontend/DB can parse them as numbers.
 */
export function formatAmount(value: string | bigint): string {
  const raw = typeof value === 'bigint' ? value.toString() : value;
  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  const withCommas = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${withCommas}` : withCommas;
}
