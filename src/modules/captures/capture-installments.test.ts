import { describe, expect, it } from 'vitest';

import {
  captureInstallmentPlanId,
  captureInstallmentRef,
  installmentAmountsCents,
  installmentDates,
  isCaptureFutureRef,
} from './capture-installments.js';

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const KEY = 'ab'.repeat(20);

describe('capture installments: references', () => {
  it('installment 1 keeps the capture reference, the others are :f<n-1>, all in one plan', () => {
    expect(captureInstallmentRef(KEY, 1)).toBe(`notif:${KEY}`);
    expect(captureInstallmentRef(KEY, 2)).toBe(`notif:${KEY}:f1`);
    expect(captureInstallmentRef(KEY, 24)).toBe(`notif:${KEY}:f23`);
    expect(captureInstallmentPlanId(KEY)).toBe(`notif:${KEY}`);
  });

  it('recognises only the future installments of a captured purchase', () => {
    expect(isCaptureFutureRef(`notif:${KEY}:f1`)).toBe(true);
    expect(isCaptureFutureRef('notif:smoke0001:f12')).toBe(true);
    expect(isCaptureFutureRef(`notif:${KEY}`)).toBe(false);
    expect(isCaptureFutureRef(`ofx:abc:12345678:f1`)).toBe(false);
    expect(isCaptureFutureRef('maxfin:2026-10:credit:3:f1')).toBe(false);
    expect(isCaptureFutureRef(null)).toBe(false);
  });
});

describe('capture installments: amounts in cents', () => {
  it('divides and puts the leftover cents on the first installment', () => {
    expect(installmentAmountsCents(10000, 3)).toEqual([3334, 3333, 3333]);
    expect(installmentAmountsCents(10000, 4)).toEqual([2500, 2500, 2500, 2500]);
    expect(installmentAmountsCents(10000, 7)).toEqual([1432, 1428, 1428, 1428, 1428, 1428, 1428]);
  });

  it('always adds back to the total', () => {
    for (let n = 2; n <= 24; n++) for (const total of [1, 99, 10000, 123457, 999999]) {
      expect(installmentAmountsCents(total, n).reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it('a corrected value is every installment', () => {
    expect(installmentAmountsCents(10000, 3, 3050)).toEqual([3050, 3050, 3050]);
  });
});

describe('capture installments: dates', () => {
  it('one per month on the purchase day', () => {
    expect(installmentDates(new Date(2026, 8, 15), 3).map(day)).toEqual(['2026-09-15', '2026-10-15', '2026-11-15']);
  });

  it('crosses the year', () => {
    expect(installmentDates(new Date(2026, 10, 20), 3).map(day)).toEqual(['2026-11-20', '2026-12-20', '2027-01-20']);
  });

  it('day 29, 30 and 31 are cut to the last day of shorter months, counted from the purchase date', () => {
    expect(installmentDates(new Date(2027, 0, 31), 4).map(day)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
    expect(installmentDates(new Date(2028, 0, 31), 3).map(day)).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
    expect(installmentDates(new Date(2026, 10, 30), 3).map(day)).toEqual(['2026-11-30', '2026-12-30', '2027-01-30']);
  });
});
