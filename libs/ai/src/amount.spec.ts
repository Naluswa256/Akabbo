import { parseAmountToMinorUnits } from './amount';

describe('parseAmountToMinorUnits', () => {
  it('parses plain integers and separators', () => {
    expect(parseAmountToMinorUnits('500000')).toBe(500000n);
    expect(parseAmountToMinorUnits('500,000')).toBe(500000n);
  });

  it('parses k/m suffixes', () => {
    expect(parseAmountToMinorUnits('200k')).toBe(200000n);
    expect(parseAmountToMinorUnits('1.5m')).toBe(1500000n);
    expect(parseAmountToMinorUnits('2M')).toBe(2000000n);
  });

  it('strips currency prefixes', () => {
    expect(parseAmountToMinorUnits('UGX 200000')).toBe(200000n);
    expect(parseAmountToMinorUnits('shs 50k')).toBe(50000n);
  });

  it('rejects non-amounts and fractional minor units', () => {
    expect(parseAmountToMinorUnits('a lot')).toBeNull();
    expect(parseAmountToMinorUnits('1.2345k')).toBeNull();
    expect(parseAmountToMinorUnits('')).toBeNull();
  });
});
