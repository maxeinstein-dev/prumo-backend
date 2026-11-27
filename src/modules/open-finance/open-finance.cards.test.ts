import { describe, expect, it, vi } from 'vitest';

import { checkCards, compareBills } from './open-finance.cards.js';
import type { PluggyBill, PluggyClient } from './pluggy.client.js';

// Invented values only.
const bill = (dueDate: string, totalAmount: number, closingDate: string | null = null): PluggyBill => ({ id: `b-${dueDate}`, dueDate, closingDate, totalAmount });

/** Prumo invoices by month: the due day of each and its statement total (reais). */
const invoices: Record<string, { dueDate: string; statementTotal: number; state: string }> = {
  '2026-10': { dueDate: '2026-10-08', statementTotal: 98.7, state: 'paid' },
  '2026-11': { dueDate: '2026-11-08', statementTotal: 1212.56, state: 'paid' },
  '2026-12': { dueDate: '2026-12-08', statementTotal: 800, state: 'open' },
};
const loadInvoice = vi.fn(async (month: string) => invoices[month] ?? { dueDate: `${month}-08`, statementTotal: 0, state: 'open' });

describe('compareBills', () => {
  it('matches each bank bill with the Prumo invoice of the same due day (its month or the one before) and compares the totals', async () => {
    const lines = await compareBills([bill('2026-11-08', 1234.56), bill('2026-10-09', 98.7)], loadInvoice);
    expect(lines).toEqual([
      { dueDate: '2026-11-08', month: '2026-11', bankCents: 123456, prumoCents: 121256, diffCents: 2200, state: 'paid' },
      { dueDate: '2026-10-09', month: '2026-10', bankCents: 9870, prumoCents: 9870, diffCents: 0, state: 'paid' },
    ]);
  });

  it('only the last 4 bills, newest first; a bill with no Prumo invoice near its due day says so', async () => {
    const many = ['2026-07-08', '2026-08-08', '2026-09-08', '2026-10-08', '2026-11-08'].map((d) => bill(d, 10));
    const lines = await compareBills(many, async () => ({ dueDate: '2030-01-01', statementTotal: 0, state: 'open' }));
    expect(lines.map((l) => l.dueDate)).toEqual(['2026-11-08', '2026-10-08', '2026-09-08', '2026-08-08']);
    expect(lines[0]).toMatchObject({ month: null, prumoCents: null, diffCents: null });
  });
});

describe('checkCards', () => {
  const db = {
    openFinanceLink: {
      findMany: async () => [
        { pluggyItemId: 'item-n', pluggyAccountId: 'pc', accountId: 'acc-card' },
        { pluggyItemId: 'item-n', pluggyAccountId: 'pb', accountId: 'acc-bank' },
      ],
    },
    account: { findMany: async () => [{ id: 'acc-card', name: 'Cartão Exemplo', type: 'CREDIT', totalBalance: '1500.00', creditLimit: '5000.00' }] },
  };
  const client = (status = 'UPDATED'): PluggyClient =>
    ({
      getItem: async (id: string) => ({ id, status, executionStatus: status === 'UPDATED' ? 'SUCCESS' : 'USER_AUTHORIZATION_EXPIRED', consentExpiresAt: null, connectorName: null }),
      listCards: async () => [{ id: 'pc', balance: 2400.5, closeDate: '2026-12-01', dueDate: '2026-12-08', creditLimit: 5000, availableCreditLimit: 2599.5, minimumPayment: null }],
      listBills: async () => [bill('2026-11-08', 1234.56)],
    }) as unknown as PluggyClient;

  it('for each link to a card: the bank balance and limit beside Prumo, and the bills compared', async () => {
    const result = await checkCards({ householdId: 'hh', db: db as never, client: client(), loadInvoice: async (_acc, month) => loadInvoice(month) });
    expect(result).toEqual([
      {
        prumoAccountId: 'acc-card',
        accountName: 'Cartão Exemplo',
        blocked: null,
        card: { bankBalanceCents: 240050, prumoBalanceCents: 150000, bankLimitCents: 500000, bankAvailableCents: 259950, prumoLimitCents: 500000, closeDate: '2026-12-01', dueDate: '2026-12-08' },
        bills: [{ dueDate: '2026-11-08', month: '2026-11', bankCents: 123456, prumoCents: 121256, diffCents: 2200, state: 'paid' }],
      },
    ]);
  });

  it('an expired authorization is reported, not read', async () => {
    const result = await checkCards({ householdId: 'hh', db: db as never, client: client('LOGIN_ERROR'), loadInvoice: async () => { throw new Error('no'); } });
    expect(result).toEqual([{ prumoAccountId: 'acc-card', accountName: 'Cartão Exemplo', blocked: 'A autorização deste banco venceu: reconecte no Meu Pluggy.' }]);
  });
});
