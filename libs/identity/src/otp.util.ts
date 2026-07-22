import { randomInt, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * OTP helpers. Codes are hashed (scrypt) before storage — the plaintext is
 * never persisted (§3, §10). Verification is constant-time.
 */

/** Generate a numeric OTP of the given length (default 6). */
export function generateOtp(length = 6): string {
  let code = '';
  for (let i = 0; i < length; i++) code += randomInt(0, 10).toString();
  return code;
}

/** Hash a code as `salt:derived` (both hex). */
export function hashOtp(code: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(code, salt, 32);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/** Constant-time verify against a stored `salt:derived` hash. */
export function verifyOtp(code: string, stored: string): boolean {
  const [saltHex, derivedHex] = stored.split(':');
  if (!saltHex || !derivedHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(derivedHex, 'hex');
  const actual = scryptSync(code, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
