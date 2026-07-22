/**
 * Money is stored as BigInt minor units in the DB (never floats — §3.4). JSON
 * cannot represent BigInt, so at the edges (audit snapshots, API responses) we
 * serialise to a decimal string. These helpers keep that conversion in one
 * place and out of the domain logic.
 */

/** BigInt → decimal string for JSON-safe snapshots and API payloads. */
export function moneyToString(value: bigint): string {
  return value.toString();
}

/** Parse an incoming integer-minor-units amount, rejecting anything invalid. */
export function parseMoney(input: unknown): bigint {
  if (typeof input === 'bigint') return assertNonNegative(input);
  if (typeof input === 'number') {
    if (!Number.isInteger(input)) {
      throw new Error('Amount must be an integer number of minor units');
    }
    return assertNonNegative(BigInt(input));
  }
  if (typeof input === 'string' && /^\d+$/.test(input)) {
    return assertNonNegative(BigInt(input));
  }
  throw new Error('Amount must be a non-negative integer (minor units)');
}

function assertNonNegative(v: bigint): bigint {
  if (v < 0n) throw new Error('Amount must be non-negative');
  return v;
}
