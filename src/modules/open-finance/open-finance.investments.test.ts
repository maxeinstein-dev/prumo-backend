import { describe, expect, it } from 'vitest';

import { compareInvestments } from './open-finance.investments.js';
import type { PluggyInvestment } from './pluggy.client.js';

// Invented tickers, names and values only.
const inv = (over: Partial<PluggyInvestment>): PluggyInvestment => ({
  id: `i-${Math.random()}`,
  name: 'Ativo Exemplo',
  code: null,
  type: 'EQUITY',
  subtype: 'STOCK',
  balance: 0,
  quantity: null,
  value: null,
  date: '2026-11-26',
  dueDate: null,
  status: 'ACTIVE',
  ...over,
});

const prumoPosition = (over: Record<string, unknown>) => ({ kind: 'STOCK_EXCHANGE', ticker: null, name: 'Posição', quantity: 0, currentValue: 0, closedAt: null, ...over });

describe('compareInvestments', () => {
  it('stocks and funds traded on the exchange match by ticker: same, different quantity, only at the bank, only in Prumo', () => {
    const result = compareInvestments({
      bank: [
        inv({ code: 'AAAA11', subtype: 'REAL_ESTATE_FUND', quantity: 10, balance: 1000 }),
        inv({ code: 'bbbb3', quantity: 5, balance: 250 }),
        inv({ code: 'CCCC11', type: 'ETF', subtype: null, quantity: 2, balance: 200 }),
        inv({ code: 'GONE11', quantity: 1, balance: 10, status: 'TOTAL_WITHDRAWAL' }),
      ],
      bankCashCents: 1210,
      prumo: {
        summary: { cashBalance: 12.1, totalValue: 1503.1 },
        positions: [
          prumoPosition({ ticker: 'AAAA11', quantity: 10, currentValue: 990 }),
          prumoPosition({ ticker: 'BBBB3', quantity: 4, currentValue: 200 }),
          prumoPosition({ ticker: 'DDDD11', quantity: 3, currentValue: 300 }),
          prumoPosition({ ticker: 'OLD11', quantity: 0, currentValue: 0, closedAt: '2026-10-01' }),
        ],
      },
    });

    expect(result.stocks).toEqual([
      { ticker: 'AAAA11', bankQuantity: 10, prumoQuantity: 10, bankCents: 100000, prumoCents: 99000, status: 'same' },
      { ticker: 'BBBB3', bankQuantity: 5, prumoQuantity: 4, bankCents: 25000, prumoCents: 20000, status: 'quantity' },
      { ticker: 'CCCC11', bankQuantity: 2, prumoQuantity: null, bankCents: 20000, prumoCents: null, status: 'bank_only' },
      { ticker: 'DDDD11', bankQuantity: null, prumoQuantity: 3, bankCents: null, prumoCents: 30000, status: 'prumo_only' },
    ]);
  });

  it('fixed income and funds compare as a total; the account total is positions plus cash on both sides', () => {
    const result = compareInvestments({
      bank: [
        inv({ code: 'AAAA11', quantity: 10, balance: 1000 }),
        inv({ type: 'FIXED_INCOME', subtype: 'LCA', name: 'LCA Exemplo', balance: 5000.5 }),
        inv({ type: 'MUTUAL_FUND', subtype: null, name: 'Fundo DI', balance: 499.5 }),
      ],
      bankCashCents: 1210,
      prumo: {
        summary: { cashBalance: 12.1, totalValue: 6508.1 },
        positions: [
          prumoPosition({ ticker: 'AAAA11', quantity: 10, currentValue: 1000 }),
          prumoPosition({ kind: 'FIXED_INCOME', name: 'LCA', currentValue: 5496 }),
        ],
      },
    });

    expect(result.others).toEqual({ bankCents: 550000, prumoCents: 549600 });
    expect(result.cash).toEqual({ bankCents: 1210, prumoCents: 1210 });
    expect(result.total).toEqual({ bankCents: 651210, prumoCents: 650810, diffCents: 400 });
  });
});

describe('checkInvestments', () => {
  it('for each link to an investment account: the broker portfolio and cash from Pluggy against the P21 portfolio', async () => {
    const { checkInvestments } = await import('./open-finance.investments.js');
    const db = {
      openFinanceLink: {
        findMany: async () => [
          { pluggyItemId: 'item-x', pluggyAccountId: 'pa-x', accountId: 'acc-inv' },
          { pluggyItemId: 'item-w', pluggyAccountId: 'pa-w', accountId: 'acc-bank' },
        ],
      },
      account: { findMany: async () => [{ id: 'acc-inv', name: 'Corretora Exemplo', type: 'INVESTMENT' }] },
    };
    const client = {
      getItem: async (id: string) => ({ id, status: 'UPDATED', executionStatus: 'SUCCESS', consentExpiresAt: null, connectorName: null }),
      listAccounts: async () => [{ id: 'pa-x', itemId: 'item-x', type: 'BANK', subtype: null, name: 'Conta', marketingName: null, number: '0', balance: 12.1, currencyCode: 'BRL' }],
      listInvestments: async () => [inv({ code: 'AAAA11', quantity: 10, balance: 1000 })],
      listTransactions: async () => [],
      checkCredentials: async () => 'ok' as const,
    };
    const loaded: string[] = [];
    const result = await checkInvestments({
      householdId: 'hh',
      db: db as never,
      client,
      loadPortfolio: async (accountId: string) => {
        loaded.push(accountId);
        return { summary: { cashBalance: 12.1, totalValue: 1012.1 }, positions: [prumoPosition({ ticker: 'AAAA11', quantity: 10, currentValue: 1000 })] };
      },
    });

    expect(loaded).toEqual(['acc-inv']);
    expect(result).toEqual([
      expect.objectContaining({
        prumoAccountId: 'acc-inv',
        accountName: 'Corretora Exemplo',
        blocked: null,
        total: { bankCents: 101210, prumoCents: 101210, diffCents: 0 },
        stocks: [expect.objectContaining({ ticker: 'AAAA11', status: 'same' })],
      }),
    ]);
  });

  it('an item with expired authorization is reported, not compared', async () => {
    const { checkInvestments } = await import('./open-finance.investments.js');
    const db = {
      openFinanceLink: { findMany: async () => [{ pluggyItemId: 'item-x', pluggyAccountId: 'pa-x', accountId: 'acc-inv' }] },
      account: { findMany: async () => [{ id: 'acc-inv', name: 'Corretora Exemplo', type: 'INVESTMENT' }] },
    };
    const client = {
      getItem: async (id: string) => ({ id, status: 'LOGIN_ERROR', executionStatus: 'USER_AUTHORIZATION_EXPIRED', consentExpiresAt: null, connectorName: null }),
      listAccounts: async () => { throw new Error('should not read'); },
      listInvestments: async () => { throw new Error('should not read'); },
      listTransactions: async () => [],
      checkCredentials: async () => 'ok' as const,
    };
    const result = await checkInvestments({ householdId: 'hh', db: db as never, client, loadPortfolio: async () => { throw new Error('no'); } });
    expect(result).toEqual([{ prumoAccountId: 'acc-inv', accountName: 'Corretora Exemplo', blocked: 'A autorização deste banco venceu: reconecte no Meu Pluggy.' }]);
  });
});
