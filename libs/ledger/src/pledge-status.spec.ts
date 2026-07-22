import { PledgeStatus } from '@prisma/client';
import { deriveStatus, outstanding } from './pledge-status';

describe('pledge status & outstanding math (§3 invariant)', () => {
  it('PLEDGED when nothing is fulfilled', () => {
    expect(deriveStatus(500000n, 0n)).toBe(PledgeStatus.PLEDGED);
  });

  it('PARTIALLY_FULFILLED on a partial payment', () => {
    expect(deriveStatus(500000n, 200000n)).toBe(PledgeStatus.PARTIALLY_FULFILLED);
  });

  it('FULFILLED when fully paid', () => {
    expect(deriveStatus(500000n, 500000n)).toBe(PledgeStatus.FULFILLED);
  });

  it('FULFILLED when overpaid', () => {
    expect(deriveStatus(500000n, 600000n)).toBe(PledgeStatus.FULFILLED);
  });

  it('CANCELLED overrides the numbers', () => {
    expect(deriveStatus(500000n, 200000n, true)).toBe(PledgeStatus.CANCELLED);
  });

  it('outstanding = committed − fulfilled, floored at zero', () => {
    expect(outstanding(500000n, 200000n)).toBe(300000n);
    expect(outstanding(500000n, 500000n)).toBe(0n);
    expect(outstanding(500000n, 600000n)).toBe(0n);
  });
});
