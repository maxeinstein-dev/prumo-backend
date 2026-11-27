import { describe, expect, it, vi } from 'vitest';

import { balanceChecks, type BalancesDb } from './open-finance.balances.js';

// Invented ids, names and values only.
const HH = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-11-28T13:05:00.000Z');

function fakeDb(links: Array<Record<string, unknown>>, accounts: Array<Record<string, unknown>>, drafts: Array<Record<string, unknown>> = []) {
  return {
    openFinanceLink: { findMany: vi.fn(async () => links) },
    account: { findMany: vi.fn(async () => accounts) },
    capturedNotification: { findMany: vi.fn(async () => drafts) },
  } as unknown as BalancesDb;
}

describe('balanceChecks', () => {
  it('compares the bank balance of the last import with Prumo\'s balance: exact accounts warn from 1 cent, estimated ones above R$ 1', async () => {
    const db = fakeDb(
      [
        { accountId: 'acc-w', bankBalance: '512.30', bankBalanceAt: AT, bankBalanceEstimated: true },
        { accountId: 'acc-b', bankBalance: '0.00', bankBalanceAt: AT, bankBalanceEstimated: false },
        { accountId: 'acc-c', bankBalance: '12.00', bankBalanceAt: AT, bankBalanceEstimated: false },
        { accountId: 'acc-never', bankBalance: null, bankBalanceAt: null, bankBalanceEstimated: false },
      ],
      [
        { id: 'acc-w', name: 'Carteira Exemplo', totalBalance: '511.80' },
        { id: 'acc-b', name: 'Banco Exemplo', totalBalance: '-0.01' },
        { id: 'acc-c', name: 'Outro Banco', totalBalance: '12.00' },
      ],
    );

    expect(await balanceChecks({ db, householdId: HH })).toEqual([
      { prumoAccountId: 'acc-w', accountName: 'Carteira Exemplo', bankCents: 51230, prumoCents: 51180, diffCents: 50, estimated: true, toleranceCents: 100, alert: false, at: AT.toISOString(), pendingCents: 0 },
      { prumoAccountId: 'acc-b', accountName: 'Banco Exemplo', bankCents: 0, prumoCents: -1, diffCents: 1, estimated: false, toleranceCents: 0, alert: true, at: AT.toISOString(), pendingCents: 0 },
      { prumoAccountId: 'acc-c', accountName: 'Outro Banco', bankCents: 1200, prumoCents: 1200, diffCents: 0, estimated: false, toleranceCents: 0, alert: false, at: AT.toISOString(), pendingCents: 0 },
    ]);
  });

  it('an estimated account warns above R$ 1 of difference', async () => {
    const db = fakeDb(
      [{ accountId: 'acc-w', bankBalance: '512.30', bankBalanceAt: AT, bankBalanceEstimated: true }],
      [{ id: 'acc-w', name: 'Carteira Exemplo', totalBalance: '502.30' }],
    );
    expect((await balanceChecks({ db, householdId: HH }))[0]).toMatchObject({ diffCents: 1000, alert: true });
  });
});

describe('balanceChecks: drafts waiting in the box (27/11/2026)', () => {
  it('each account says how much its pending Open Finance drafts add up to (income +, expense -)', async () => {
    const db = fakeDb(
      [{ accountId: 'acc-w', bankBalance: '1052.70', bankBalanceAt: AT, bankBalanceEstimated: true }],
      [{ id: 'acc-w', name: 'Carteira Exemplo', totalBalance: '412.70' }],
      [
        { parsed: { type: 'INCOME', amountCents: 64000, accountId: 'acc-w' } },
        { parsed: { type: 'EXPENSE', amountCents: 500, accountId: 'acc-w' } },
        { parsed: { type: 'INCOME', amountCents: 999, accountId: 'acc-other' } },
        { parsed: null },
      ],
    );
    const [check] = await balanceChecks({ db, householdId: HH });
    expect(check).toMatchObject({ diffCents: 64000, pendingCents: 63500, alert: true });
    expect(db.capturedNotification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { householdId: HH, package: 'open-finance', status: 'PENDING' } }),
    );
  });
});
