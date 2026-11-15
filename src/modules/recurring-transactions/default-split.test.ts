import { describe, expect, it } from 'vitest';

import { defaultSplitParts, validateDefaultShares } from './default-split.js';

// Invented data only.
const MAE = 'person-mae';
const ANA = 'person-ana';
const BIA = 'person-bia';
const active = new Set([MAE, ANA, BIA]);

describe('defaultSplitParts (P19)', () => {
  it('100% to another person hands out the whole amount', () => {
    expect(defaultSplitParts(20899, [{ personId: MAE, percent: 100, amount: null }], active)).toEqual([{ personId: MAE, amountCents: 20899 }]);
  });

  it('50% of an amount that does not divide in cents rounds the part down (the cent stays with me)', () => {
    expect(defaultSplitParts(10001, [{ personId: ANA, percent: 50, amount: null }], active)).toEqual([{ personId: ANA, amountCents: 5000 }]);
  });

  it('percents that add up to 100 hand out every cent (the first person takes the rest)', () => {
    const parts = defaultSplitParts(10001, [
      { personId: ANA, percent: 50, amount: null },
      { personId: BIA, percent: 50, amount: null },
    ], active);
    expect(parts).toEqual([{ personId: ANA, amountCents: 5001 }, { personId: BIA, amountCents: 5000 }]);
    expect(parts.reduce((sum, p) => sum + p.amountCents, 0)).toBe(10001);
  });

  it('the percent is taken from the real amount of the occurrence', () => {
    expect(defaultSplitParts(18750, [{ personId: ANA, percent: 50, amount: null }], active)).toEqual([{ personId: ANA, amountCents: 9375 }]);
  });

  it('a fixed amount is capped by what is left of the occurrence', () => {
    expect(defaultSplitParts(3000, [{ personId: ANA, percent: null, amount: 50 }], active)).toEqual([{ personId: ANA, amountCents: 3000 }]);
    expect(defaultSplitParts(10000, [
      { personId: ANA, percent: null, amount: 70 },
      { personId: BIA, percent: null, amount: 70 },
    ], active)).toEqual([{ personId: ANA, amountCents: 7000 }, { personId: BIA, amountCents: 3000 }]);
  });

  it('an inactive person gets no part (it stays with me)', () => {
    expect(defaultSplitParts(10000, [
      { personId: 'person-gone', percent: 50, amount: null },
      { personId: ANA, percent: 25, amount: null },
    ], active)).toEqual([{ personId: ANA, amountCents: 2500 }]);
  });

  it('no rule, or no amount, gives no part', () => {
    expect(defaultSplitParts(10000, [], active)).toEqual([]);
    expect(defaultSplitParts(0, [{ personId: ANA, percent: 50, amount: null }], active)).toEqual([]);
  });

  it('a part that rounds to zero cents is dropped', () => {
    expect(defaultSplitParts(1, [{ personId: ANA, percent: 10, amount: null }], active)).toEqual([]);
  });
});

describe('validateDefaultShares (P19)', () => {
  it('accepts percents up to 100 and fixed amounts', () => {
    expect(validateDefaultShares([{ personId: ANA, percent: 50 }, { personId: BIA, percent: 50 }])).toBeNull();
    expect(validateDefaultShares([{ personId: ANA, amount: 104.5 }])).toBeNull();
    expect(validateDefaultShares([])).toBeNull();
  });

  it('refuses a mix of percent and amount, both or neither on one entry, sums over 100 and repeated people', () => {
    expect(validateDefaultShares([{ personId: ANA, percent: 50 }, { personId: BIA, amount: 10 }])).toMatch(/same kind/);
    expect(validateDefaultShares([{ personId: ANA, percent: 50, amount: 10 }])).toMatch(/percent or an amount/);
    expect(validateDefaultShares([{ personId: ANA }])).toMatch(/percent or an amount/);
    expect(validateDefaultShares([{ personId: ANA, percent: 60 }, { personId: BIA, percent: 41 }])).toMatch(/100/);
    expect(validateDefaultShares([{ personId: ANA, percent: 10 }, { personId: ANA, percent: 10 }])).toMatch(/more than once/);
    expect(validateDefaultShares([{ personId: ANA, percent: 0 }])).toMatch(/percent/);
    expect(validateDefaultShares([{ personId: ANA, percent: 33.333 }])).toMatch(/decimal/);
    expect(validateDefaultShares([{ personId: ANA, amount: -1 }])).toMatch(/amount/);
  });
});
