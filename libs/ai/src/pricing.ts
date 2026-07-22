import { LlmUsage } from '@akabbo/providers';

/** Per-1M-token prices (USD) by model prefix — metering doc assumptions. */
const PRICES: Record<string, { in: number; out: number }> = {
  'gemini-2.5-flash': { in: 0.3, out: 2.5 },
  'gemini-2.5-flash-lite': { in: 0.1, out: 0.4 },
  'claude-haiku': { in: 1.0, out: 5.0 },
};

function priceFor(model: string): { in: number; out: number } {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  // Unknown model → assume the Flash rate (our default workhorse).
  return key ? PRICES[key] : PRICES['gemini-2.5-flash'];
}

/**
 * Compute an LLM call's cost in integer micro-USD (no floats stored). This is
 * for observability/attribution only — never a billing gate (metering doc §1).
 */
export function costMicroUsd(usage: LlmUsage): bigint {
  const p = priceFor(usage.model);
  const usd = (usage.inputTokens * p.in + usage.outputTokens * p.out) / 1_000_000;
  return BigInt(Math.round(usd * 1_000_000));
}
