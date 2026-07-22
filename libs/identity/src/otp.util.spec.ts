import { generateOtp, hashOtp, verifyOtp } from './otp.util';

describe('OTP hashing (codes never stored in plaintext — §10)', () => {
  it('generates a 6-digit numeric code by default', () => {
    const code = generateOtp();
    expect(code).toMatch(/^\d{6}$/);
  });

  it('verifies a correct code against its hash', () => {
    const code = generateOtp();
    const hash = hashOtp(code);
    expect(hash).not.toContain(code); // plaintext is not in the stored value
    expect(verifyOtp(code, hash)).toBe(true);
  });

  it('rejects an incorrect code', () => {
    const hash = hashOtp('123456');
    expect(verifyOtp('654321', hash)).toBe(false);
  });

  it('rejects a malformed stored hash', () => {
    expect(verifyOtp('123456', 'not-a-valid-hash')).toBe(false);
  });
});
