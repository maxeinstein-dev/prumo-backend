import { describe, expect, it } from 'vitest';

import type { BankLine } from './open-finance.classify.js';
import { ignoredSavingsNames, savingsBalanceOn, splitYields, type SavingsConfig } from './open-finance.savings.js';

// Invented names and values only.
const OURS: SavingsConfig = { name: 'Cofrinho Azul', aliases: ['Reserva Antiga'], inPrumo: true, approxCents: 40000, asOf: '2026-11-20' };
const THEIRS: SavingsConfig = { name: 'Cofrinho Pai', aliases: [], inPrumo: false, approxCents: 4500000, asOf: '2026-11-20' };

let seq = 0;
const line = (date: string, cents: number, description: string, kind: BankLine['kind'], savingsName: string | null = null): BankLine => ({
  id: `l-${++seq}`,
  pluggyAccountId: 'pa',
  prumoAccountId: 'acc',
  date,
  cents,
  description,
  kind,
  savingsName,
});

describe('ignoredSavingsNames', () => {
  it('the names and aliases of the savings that are not Prumo money', () => {
    expect(ignoredSavingsNames([OURS, { ...THEIRS, aliases: ['Pai Antigo'] }])).toEqual(['Cofrinho Pai', 'Pai Antigo']);
  });
});

describe('savingsBalanceOn', () => {
  const moves = [
    line('2026-11-18', -10000, 'Dinheiro reservado Reserva Antiga', 'savings', 'Reserva Antiga'), // +100,00 into ours (alias)
    line('2026-11-22', 5000, 'Dinheiro retirado Cofrinho Azul', 'savings', 'Cofrinho Azul'), // -50,00 out of ours
    line('2026-11-22', -5000, 'Dinheiro retirado', 'savings', null), // account side: not a savings move
  ];

  it('moves after the registered day change the balance forward; moves before it, backward', () => {
    expect(savingsBalanceOn(OURS, '2026-11-20', moves)).toBe(40000);
    expect(savingsBalanceOn(OURS, '2026-11-22', moves)).toBe(35000);
    expect(savingsBalanceOn(OURS, '2026-11-17', moves)).toBe(30000);
    expect(savingsBalanceOn(OURS, '2026-11-18', moves)).toBe(40000);
  });

  it('without a registered balance the balance is unknown', () => {
    expect(savingsBalanceOn({ ...OURS, approxCents: null, asOf: null }, '2026-11-20', moves)).toBeNull();
  });
});

describe('splitYields', () => {
  it('splits each day\'s yield by the balances of the day before and sums Prumo\'s part per month', () => {
    const lines = [
      line('2026-11-21', 20, 'Rendimentos', 'yield'),
      line('2026-11-21', 1900, 'Rendimentos', 'yield'),
      line('2026-10-30', 15, 'Rendimentos', 'yield'),
    ];
    // Ours 400,00 of 45.400,00 -> 0,881 %: 19,20 -> 0,17 (rounded per day).
    expect(splitYields(lines, [OURS, THEIRS])).toEqual([
      { month: '2026-10', cents: 15, prumoCents: 0 },
      { month: '2026-11', cents: 1920, prumoCents: 17 },
    ]);
  });

  it('a month is "unknown" (null) when a savings has no registered balance', () => {
    const lines = [line('2026-11-21', 100, 'Rendimentos', 'yield')];
    expect(splitYields(lines, [OURS, { ...THEIRS, approxCents: null, asOf: null }])).toEqual([{ month: '2026-11', cents: 100, prumoCents: null }]);
  });

  it('with no savings registered at all, Prumo\'s part is unknown', () => {
    expect(splitYields([line('2026-11-21', 100, 'Rendimentos', 'yield')], [])).toEqual([{ month: '2026-11', cents: 100, prumoCents: null }]);
  });
});

describe('estimatedSavingsBalance (P25 L3)', () => {
  it('the registered balance plus its named moves plus its share of each day\'s yield after the registered day', async () => {
    const { estimatedSavingsBalance } = await import('./open-finance.savings.js');
    const lines = [
      line('2026-11-19', 500, 'Rendimentos', 'yield'), // before the registered day: already in the balance
      line('2026-11-21', 1920, 'Rendimentos', 'yield'), // 400 of 45.400 -> 17 cents are ours
      line('2026-11-22', 5000, 'Dinheiro retirado Cofrinho Azul', 'savings', 'Cofrinho Azul'), // -50,00
      line('2026-11-23', 1000, 'Rendimentos', 'yield'), // 350 of 45.350 -> 8 cents
    ];
    expect(estimatedSavingsBalance(OURS, '2026-11-23', lines, [OURS, THEIRS])).toBe(40000 + 17 - 5000 + 8);
  });

  it('unknown when the savings (or any other) has no registered balance', async () => {
    const { estimatedSavingsBalance } = await import('./open-finance.savings.js');
    expect(estimatedSavingsBalance({ ...OURS, approxCents: null, asOf: null }, '2026-11-23', [], [OURS])).toBeNull();
    expect(estimatedSavingsBalance(OURS, '2026-11-23', [line('2026-11-21', 100, 'Rendimentos', 'yield')], [OURS, { ...THEIRS, approxCents: null, asOf: null }])).toBeNull();
  });
});
