import { describe, expect, it, vi } from 'vitest';

import { balanceChecks, type BalancesDb } from './open-finance.balances.js';

// Invented ids, names and values only.
const HH = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-11-28T13:05:00.000Z');

function fakeDb(links: Array<Record<string, unknown>>, accounts: Array<Record<string, unknown>>) {
  return {
    openFinanceLink: { findMany: vi.fn(async () => links) },
    account: { findMany: vi.fn(async () => accounts) },
  } as unknown as BalancesDb;
}

describe('balanceChecks', () => {
  it('compares the bank balance of the last import with Prumo\'s balance: exact accounts warn from 1 cent, estimated ones above R$ 1', async () => {
    const db = fakeDb(
      [
        { accountId: 'acc-w', bankBalance: '401.40', bankBalanceAt: AT, bankBalanceEstimated: true },
        { accountId: 'acc-b', bankBalance: '0.00', bankBalanceAt: AT, bankBalanceEstimated: false },
        { accountId: 'acc-c', bankBalance: '12.00', bankBalanceAt: AT, bankBalanceEstimated: false },
        { accountId: 'acc-never', bankBalance: null, bankBalanceAt: null, bankBalanceEstimated: false },
      ],
      [
        { id: 'acc-w', name: 'Carteira Exemplo', totalBalance: '400.90' },
        { id: 'acc-b', name: 'Banco Exemplo', totalBalance: '-0.01' },
        { id: 'acc-c', name: 'Outro Banco', totalBalance: '12.00' },
      ],
    );

    expect(await balanceChecks({ db, householdId: HH })).toEqual([
      { prumoAccountId: 'acc-w', accountName: 'Carteira Exemplo', bankCents: 40140, prumoCents: 40090, diffCents: 50, estimated: true, toleranceCents: 100, alert: false, at: AT.toISOString() },
      { prumoAccountId: 'acc-b', accountName: 'Banco Exemplo', bankCents: 0, prumoCents: -1, diffCents: 1, estimated: false, toleranceCents: 0, alert: true, at: AT.toISOString() },
      { prumoAccountId: 'acc-c', accountName: 'Outro Banco', bankCents: 1200, prumoCents: 1200, diffCents: 0, estimated: false, toleranceCents: 0, alert: false, at: AT.toISOString() },
    ]);
  });

  it('an estimated account warns above R$ 1 of difference', async () => {
    const db = fakeDb(
      [{ accountId: 'acc-w', bankBalance: '401.40', bankBalanceAt: AT, bankBalanceEstimated: true }],
      [{ id: 'acc-w', name: 'Carteira Exemplo', totalBalance: '391.40' }],
    );
    expect((await balanceChecks({ db, householdId: HH }))[0]).toMatchObject({ diffCents: 1000, alert: true });
  });
});
