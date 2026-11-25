import { describe, expect, it } from 'vitest';
import { STUDY_RETENTION_DAYS, investmentSourceRef, isInvestmentDraftKind, isXpKind, saoPauloDay, studyCutoff, suggestedQuantity } from './capture-xp.js';

describe('suggestedQuantity (decision 4: executed amount / quote of the day, nearest integer, at least 1)', () => {
  it.each([
    [777, 8.26, 1], // 0.94 -> 1
    [2400, 8, 3],
    [1234, 10, 1], // 1.234 -> 1
    [1500, 10, 2], // 1.5 -> 2 (half rounds up)
    [1499, 10, 1],
    [40, 10, 1], // 0.04 -> never 0
    [10000, 12.5, 8],
  ])('%d cents at %d is %d', (cents, price, expected) => {
    expect(suggestedQuantity(cents, price)).toBe(expected);
  });

  it('gives no suggestion without a usable quote', () => {
    expect(suggestedQuantity(777, null)).toBeNull();
    expect(suggestedQuantity(777, 0)).toBeNull();
    expect(suggestedQuantity(777, -1)).toBeNull();
    expect(suggestedQuantity(777, Number.NaN)).toBeNull();
  });
});

describe('kinds', () => {
  it('knows the XP kinds and which of them make a draft', () => {
    expect(isXpKind('XP_INCOME')).toBe(true);
    expect(isXpKind('XP_STUDY')).toBe(true);
    expect(isXpKind('CARD_PURCHASE')).toBe(false);
    expect(isXpKind(null)).toBe(false);
    expect(isInvestmentDraftKind('XP_INCOME')).toBe('INCOME');
    expect(isInvestmentDraftKind('XP_REINVEST_DONE')).toBe('BUY');
    expect(isInvestmentDraftKind('XP_REINVEST_NOTICE')).toBeNull();
    expect(isInvestmentDraftKind('XP_STUDY')).toBeNull();
  });

  it('the movement reference is the capture reference of a transaction (one per household)', () => {
    expect(investmentSourceRef('abc')).toBe('notif:abc');
  });
});

describe('dates', () => {
  it('uses the Brasilia day of the notification (21:09 there is already the next UTC day)', () => {
    expect(saoPauloDay(new Date('2026-11-25T00:09:00.000Z'))).toBe('2026-11-24');
    expect(saoPauloDay(new Date('2026-11-24T15:00:00.000Z'))).toBe('2026-11-24');
  });

  it('keeps the study captures for 60 days', () => {
    expect(STUDY_RETENTION_DAYS).toBe(60);
    expect(studyCutoff(new Date('2026-11-25T12:00:00.000Z')).toISOString()).toBe('2026-09-26T12:00:00.000Z');
  });
});
