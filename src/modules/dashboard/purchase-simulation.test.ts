import { describe, expect, it } from 'vitest';
import { installmentMonths, splitInstallmentCents } from './purchase-simulation.js';

// Invented numbers. The split is in whole cents: the parts add up to the total, the leftover cents go to the first parts.
describe('splitInstallmentCents', () => {
  it('adds up exactly to the total, leaving the extra cents in the first parts', () => {
    expect(splitInstallmentCents(10000, 3)).toEqual([3334, 3333, 3333]);
    expect(splitInstallmentCents(10001, 3)).toEqual([3334, 3334, 3333]);
    expect(splitInstallmentCents(10, 3)).toEqual([4, 3, 3]);
  });

  it('one installment is the whole amount', () => {
    expect(splitInstallmentCents(12345, 1)).toEqual([12345]);
  });

  it('24 installments still add up to the cent, for many totals', () => {
    for (const total of [24, 25, 99999, 123457, 2_400_001, 999_999_999]) {
      const parts = splitInstallmentCents(total, 24);
      expect(parts).toHaveLength(24);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
      expect([...parts].sort((a, b) => b - a)).toEqual(parts); // never a smaller part before a bigger one
    }
  });

  it('refuses what cannot be paid in whole cents', () => {
    expect(() => splitInstallmentCents(0, 3)).toThrow();
    expect(() => splitInstallmentCents(100.5, 3)).toThrow();
    expect(() => splitInstallmentCents(100, 0)).toThrow();
    expect(() => splitInstallmentCents(100, 25)).toThrow();
    expect(() => splitInstallmentCents(5, 6)).toThrow(); // a part would be zero
  });
});

describe('installmentMonths', () => {
  it('goes one month at a time and crosses the year', () => {
    expect(installmentMonths('2026-11', 4)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(installmentMonths('2026-01', 1)).toEqual(['2026-01']);
    expect(installmentMonths('2026-12', 24).at(-1)).toBe('2028-11');
  });
});
