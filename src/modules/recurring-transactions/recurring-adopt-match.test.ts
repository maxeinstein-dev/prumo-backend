import { describe, expect, it } from 'vitest';

import { ADOPT_DAYS_AFTER, ADOPT_DAYS_BEFORE, adoptWindowStart, rankAdoptable, similarName } from './recurring-adopt-match.js';
import { recurrenceNameKeys } from './recurring-aliases.js';

// Invented data only.
const names = recurrenceNameKeys('Seguro Alfa', ['Pg *Alfa Seguros Digital']);
const base = { names, expectedAmounts: [90], dueDay: '2026-10-24', foreignNames: new Set<string>() };
const row = (id: string, description: string, amount: number, date: string) => ({ id, description, amount, date });

describe('similarName', () => {
  it('matches when one compact name contains the other (6+ letters)', () => {
    expect(similarName('alfa seguros digital', names)).toBe(true); // capture without the "Pg *" prefix
    expect(similarName('pg alfa seguros digital sp', names)).toBe(true);
    expect(similarName('seguroalfa', names)).toBe(true); // spaces do not matter
  });

  it('does not match short or unrelated names', () => {
    expect(similarName('seguro beta', names)).toBe(false);
    expect(similarName('alfa', names)).toBe(false); // too short to stand for the name
    expect(similarName('', names)).toBe(false);
  });
});

describe('adoptWindowStart', () => {
  it('reaches back into the previous month only near its end', () => {
    expect(adoptWindowStart('2026-11-03')).toBe('2026-10-27');
    expect(adoptWindowStart('2026-11-24')).toBe('2026-11-01');
    expect(ADOPT_DAYS_BEFORE).toBe(7);
    expect(ADOPT_DAYS_AFTER).toBe(3);
  });
});

describe('rankAdoptable', () => {
  it('takes the same name or alias whatever the amount (the PR #29 rule)', () => {
    expect(rankAdoptable([row('a', 'Pg *Alfa Seguros Digital', 118.47, '2026-10-23')], base)).toEqual(['a']);
    expect(rankAdoptable([row('a', 'SEGURO ALFA', 10, '2026-10-02')], base)).toEqual(['a']);
  });

  it('takes a similar name only with a close amount and near the due day', () => {
    const near = row('near', 'Alfa Seguros Digital', 92, '2026-10-23');
    expect(rankAdoptable([near], base)).toEqual(['near']);
    expect(rankAdoptable([{ ...near, amount: 120 }], base)).toEqual([]); // amount too far (> 10%)
    expect(rankAdoptable([{ ...near, date: '2026-10-10' }], base)).toEqual([]); // 14 days before the due day
    expect(rankAdoptable([{ ...near, date: '2026-10-28' }], base)).toEqual([]); // 4 days after
    expect(rankAdoptable([{ ...near, date: '2026-10-17' }], base)).toEqual(['near']); // 7 days before
    expect(rankAdoptable([{ ...near, date: '2026-10-27' }], base)).toEqual(['near']); // 3 days after
  });

  it('accepts the amount of any expected value (full or discounted)', () => {
    expect(rankAdoptable([row('a', 'Alfa Seguros Digital', 80, '2026-10-24')], { ...base, expectedAmounts: [90, 80] })).toEqual(['a']);
  });

  it('never takes a similar name that is exactly the name of another recurrence', () => {
    const foreignNames = recurrenceNameKeys('Alfa Seguros Digital', []);
    expect(rankAdoptable([row('a', 'Alfa Seguros Digital', 90, '2026-10-24')], base)).toEqual(['a']); // similar to the alias…
    expect(rankAdoptable([row('a', 'Alfa Seguros Digital', 90, '2026-10-24')], { ...base, foreignNames })).toEqual([]); // …but exactly another recurrence's name
  });

  it('prefers the same name, then the closest day, then the closest amount', () => {
    const ranked = rankAdoptable(
      [
        row('similar', 'Alfa Seguros Digital', 90, '2026-10-24'),
        row('far', 'Seguro Alfa', 50, '2026-10-02'),
        row('close', 'Seguro Alfa', 50, '2026-10-21'),
        row('similar-off', 'Alfa Seguros Digital', 95, '2026-10-24'),
      ],
      base,
    );
    expect(ranked).toEqual(['close', 'far', 'similar', 'similar-off']);
  });
});
