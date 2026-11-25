import { describe, expect, it } from 'vitest';
import {
  cashEffectCents,
  computePosition,
  incomeLast12MonthsCents,
  sortMovements,
  type CalcMovement,
} from './investments.calc.js';

// Invented data only.
let seq = 0;
const mv = (type: CalcMovement['type'], date: string, quantity: number | null, amountCents: number): CalcMovement => ({
  id: `m${++seq}`,
  type,
  date,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
  quantity,
  amountCents,
});

describe('cashEffectCents: what a movement does to the cash held at the broker', () => {
  it('OPENING does not touch the cash (the position existed before the load)', () => {
    expect(cashEffectCents('OPENING', 100000)).toBe(0);
  });
  it('BUY spends cash; SELL and INCOME bring cash in', () => {
    expect(cashEffectCents('BUY', 5000)).toBe(-5000);
    expect(cashEffectCents('SELL', 7000)).toBe(7000);
    expect(cashEffectCents('INCOME', 120)).toBe(120);
  });
});

describe('computePosition (stock exchange)', () => {
  it('opening gives quantity, cost and average price', () => {
    const p = computePosition('STOCK_EXCHANGE', [mv('OPENING', '2026-01-10', 10, 100000)]);
    expect(p.quantity).toBe(10);
    expect(p.costCents).toBe(100000);
    expect(p.avgPrice).toBe(100);
  });

  it('a buy joins the weighted average: 10 at 100,00 + 1 at 120,00 = 11 at 101,818182', () => {
    const p = computePosition('STOCK_EXCHANGE', [
      mv('OPENING', '2026-01-10', 10, 100000),
      mv('BUY', '2026-02-10', 1, 12000),
    ]);
    expect(p.quantity).toBe(11);
    expect(p.costCents).toBe(112000);
    expect(p.avgPrice).toBe(101.818182);
  });

  it('a sell lowers the quantity and keeps the average price (the sale price does not move it)', () => {
    const p = computePosition('STOCK_EXCHANGE', [
      mv('OPENING', '2026-01-10', 10, 100000),
      mv('SELL', '2026-02-10', 4, 60000), // sold at 150,00 each
    ]);
    expect(p.quantity).toBe(6);
    expect(p.avgPrice).toBe(100);
    expect(p.costCents).toBe(60000);
  });

  it('a sell keeps the average price within a cent-per-unit rounding when the cost does not divide', () => {
    const p = computePosition('STOCK_EXCHANGE', [
      mv('OPENING', '2026-01-10', 3, 10000), // 33,3333.. each
      mv('SELL', '2026-02-10', 1, 5000),
    ]);
    expect(p.quantity).toBe(2);
    expect(p.costCents).toBe(6667);
    expect(Math.abs(p.avgPrice! - 100 / 3)).toBeLessThan(0.01);
  });

  it('selling everything leaves zero quantity, zero cost and no average', () => {
    const p = computePosition('STOCK_EXCHANGE', [
      mv('OPENING', '2026-01-10', 2.5, 25000),
      mv('SELL', '2026-02-10', 2.5, 30000),
    ]);
    expect(p.quantity).toBe(0);
    expect(p.costCents).toBe(0);
    expect(p.avgPrice).toBeNull();
  });

  it('income changes neither quantity nor average price, only the income total', () => {
    const base = [mv('OPENING', '2026-01-10', 10, 100000)];
    const withIncome = [...base, mv('INCOME', '2026-02-10', null, 950)];
    const a = computePosition('STOCK_EXCHANGE', base);
    const b = computePosition('STOCK_EXCHANGE', withIncome);
    expect(b.quantity).toBe(a.quantity);
    expect(b.avgPrice).toBe(a.avgPrice);
    expect(b.costCents).toBe(a.costCents);
    expect(b.incomeCents).toBe(950);
  });

  it('selling more than held is refused', () => {
    expect(() =>
      computePosition('STOCK_EXCHANGE', [mv('OPENING', '2026-01-10', 2, 20000), mv('SELL', '2026-02-10', 3, 30000)]),
    ).toThrow(/more than/i);
  });

  it('orders by date, then by creation: a back-dated buy supports a later sell', () => {
    const sell = mv('SELL', '2026-03-01', 5, 50000);
    const buy = mv('BUY', '2026-02-01', 5, 40000); // created after, but dated before
    const p = computePosition('STOCK_EXCHANGE', [sell, buy]);
    expect(p.quantity).toBe(0);
  });

  it('a sell dated before the buy that supports it is refused', () => {
    expect(() =>
      computePosition('STOCK_EXCHANGE', [mv('BUY', '2026-03-01', 5, 40000), mv('SELL', '2026-02-01', 5, 50000)]),
    ).toThrow(/more than/i);
  });

  it('same date: creation order decides', () => {
    const a = mv('BUY', '2026-02-01', 5, 40000);
    const b = mv('SELL', '2026-02-01', 5, 50000);
    expect(sortMovements([b, a]).map((m) => m.id)).toEqual([a.id, b.id]);
    expect(computePosition('STOCK_EXCHANGE', [b, a]).quantity).toBe(0);
  });

  it('supports fractional quantity with six decimals without float drift', () => {
    const p = computePosition('STOCK_EXCHANGE', [
      mv('OPENING', '2026-01-10', 0.1, 1000),
      mv('BUY', '2026-01-11', 0.2, 2000),
    ]);
    expect(p.quantity).toBe(0.3);
    expect(p.costCents).toBe(3000);
  });

  it('keeps integer cents with large values', () => {
    const p = computePosition('STOCK_EXCHANGE', [mv('OPENING', '2026-01-10', 1234567.123456, 98765432109)]);
    expect(Number.isInteger(p.costCents)).toBe(true);
    expect(p.costCents).toBe(98765432109);
  });
});

describe('computePosition (fixed income): works with value only, no quantity', () => {
  it('opening and extra deposits add to the amount applied; quantity and average price do not exist', () => {
    const p = computePosition('FIXED_INCOME', [mv('OPENING', '2026-01-10', null, 500000), mv('BUY', '2026-02-10', null, 100000)]);
    expect(p.costCents).toBe(600000);
    expect(p.quantity).toBeNull();
    expect(p.avgPrice).toBeNull();
  });

  it('a redemption lowers the amount applied but never below zero', () => {
    const p = computePosition('FIXED_INCOME', [
      mv('OPENING', '2026-01-10', null, 500000),
      mv('SELL', '2026-06-10', null, 200000),
      mv('SELL', '2026-07-10', null, 400000), // redeems more than was applied (the yield)
    ]);
    expect(p.costCents).toBe(0);
  });

  it('income is summed', () => {
    const p = computePosition('FIXED_INCOME', [mv('OPENING', '2026-01-10', null, 500000), mv('INCOME', '2026-02-10', null, 1500)]);
    expect(p.incomeCents).toBe(1500);
    expect(p.costCents).toBe(500000);
  });
});

describe('incomeLast12MonthsCents', () => {
  const ms = [
    mv('INCOME', '2025-11-25', null, 100), // exactly a year ago: out
    mv('INCOME', '2025-11-26', null, 200), // in
    mv('INCOME', '2026-11-25', null, 400), // today: in
    mv('BUY', '2026-11-01', 1, 9999), // not income
  ];
  it('sums only income inside the 12 months ending today', () => {
    expect(incomeLast12MonthsCents(ms, '2026-11-25')).toBe(600);
  });
});
