import { parseAmountToMinorUnits } from './amount';
import { ToolCall } from './tools/tool-call';

/**
 * Tier-1 deterministic parser (CLAUDE.md §9). Handles the common, well-shaped
 * utterances at $0 and instant latency — the target is 40–55% of capture turns
 * never reaching the LLM. Anything it can't confidently parse returns null and
 * the orchestrator escalates to the LLM (tier 2).
 *
 * It is intentionally conservative: it would rather return null (escalate) than
 * mis-parse. It never authorises anything — its output is a *request* that still
 * passes both gates in the domain services.
 */

const PAYMENT_VERBS = ['paid', 'sent', 'gave', 'deposited', 'contributed', 'brought', 'dropped'];
const PLEDGE_VERBS = ['pledged', 'promised', 'committed'];

// First money-looking token in a string → minor units.
const MONEY_TOKEN = /(?:ugx|usd|shs?|\$)?\s?(\d[\d,]*(?:\.\d+)?\s?[km]?)/i;

function extractAmount(text: string): bigint | null {
  const m = text.match(MONEY_TOKEN);
  if (!m) return null;
  return parseAmountToMinorUnits(m[1]);
}

function looksLikeAmount(text: string): boolean {
  return /^\s*(?:ugx|usd|shs?|\$)?\s?\d[\d,]*(?:\.\d+)?\s?[km]?\s*$/i.test(text);
}

export function parseTier1(utterance: string): ToolCall | null {
  const text = utterance.trim().replace(/\s+/g, ' ');
  if (!text) return null;

  // --- Reads first (cheap keyword checks) ------------------------------------
  if (/\b(summary|totals?|how much (have|did) we (raise[d]?|collect(ed)?|get))\b/i.test(text)) {
    return { tool: 'get_summary', args: {} };
  }
  const owesMatch = text.match(/how much does (.+?) owe|(.+?)['’]s (?:balance|outstanding)/i);
  if (owesMatch) {
    const name = (owesMatch[1] ?? owesMatch[2] ?? '').trim();
    if (name) return { tool: 'get_outstanding', args: { personName: name } };
  }
  if (/\b(who owes|outstanding|remaining balance|what('?s| is) outstanding)\b/i.test(text)) {
    return { tool: 'get_outstanding', args: {} };
  }

  // --- Payment / pledge: "<name> <verb> <amount ...>" ------------------------
  const verbMatch = text.match(
    /^(?:record\s+|note\s+|log\s+)?(.+?)\s+(paid|sent|gave|deposited|contributed|brought|dropped|pledged|promised|committed)\s+(.+)$/i,
  );
  if (verbMatch) {
    const name = verbMatch[1].trim();
    const verb = verbMatch[2].toLowerCase();
    const amount = extractAmount(verbMatch[3]);
    if (name && !looksLikeAmount(name) && amount !== null && amount > 0n) {
      if (PAYMENT_VERBS.includes(verb)) {
        return { tool: 'record_payment', args: { personName: name, amount: amount.toString() } };
      }
      if (PLEDGE_VERBS.includes(verb)) {
        return { tool: 'record_pledge', args: { personName: name, amount: amount.toString() } };
      }
    }
  }

  // --- Add a person: "add <name>" --------------------------------------------
  const addMatch = text.match(/^(?:add|new)\s+(?:person\s+|contributor\s+)?(.+)$/i);
  if (addMatch) {
    const name = addMatch[1].trim().replace(/[.,!?]+$/, '');
    // Don't create a "person" that is really an amount or a command fragment.
    if (name && !looksLikeAmount(name) && name.length <= 200) {
      return { tool: 'add_person', args: { displayName: name } };
    }
  }

  return null;
}
