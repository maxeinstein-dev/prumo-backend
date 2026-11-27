import { describe, expect, it, vi } from 'vitest';

import { checkOpenFinance, type CheckDb } from './open-finance.check.js';
import type { PluggyAccount, PluggyClient, PluggyItem, PluggyTransaction } from './pluggy.client.js';

// Invented ids and values only.
const HH = '11111111-1111-4111-8111-111111111111';
const ITEM_W = 'aaaaaaaa-0000-4000-8000-00000000000a'; // a wallet with savings
const ITEM_B = 'aaaaaaaa-0000-4000-8000-00000000000b'; // a bank with a checking account and a card
const ITEM_X = 'aaaaaaaa-0000-4000-8000-00000000000c'; // expired authorization
const PW = 'pw';
const PB = 'pb';
const PCARD = 'pcard';
const PX = 'px';
const PINV = 'pinv';
const ACC_W = 'cccccccc-0000-4000-8000-000000000001';
const ACC_B = 'cccccccc-0000-4000-8000-000000000002';
const ACC_CARD = 'cccccccc-0000-4000-8000-000000000003';
const ACC_X = 'cccccccc-0000-4000-8000-000000000004';
const ACC_INV = 'cccccccc-0000-4000-8000-000000000005';
const NOW = new Date('2026-11-26T15:00:00.000Z');

let seq = 0;
const t = (accountId: string, date: string, amount: number, description: string): PluggyTransaction => ({
  id: `t-${++seq}`,
  accountId,
  date,
  amount,
  description,
  type: amount < 0 ? 'DEBIT' : 'CREDIT',
  status: 'POSTED',
});
const acc = (id: string, itemId: string, type: 'BANK' | 'CREDIT'): PluggyAccount => ({
  id,
  itemId,
  type,
  subtype: null,
  name: `Conta ${id}`,
  marketingName: null,
  number: '0000',
  balance: 0,
  currencyCode: 'BRL',
});
const item = (id: string, status = 'UPDATED', executionStatus: string | null = 'SUCCESS'): PluggyItem => ({
  id,
  status,
  executionStatus,
  consentExpiresAt: null,
  connectorName: 'Banco Inventado',
});

const TX: Record<string, PluggyTransaction[]> = {
  [PW]: [
    t(PW, '2026-11-20', 0.3, 'Rendimentos'),
    t(PW, '2026-11-21', 0.25, 'Rendimentos'),
    t(PW, '2026-10-30', 0.1, 'Rendimentos'),
    t(PW, '2026-11-18', 27, 'Dinheiro retirado Cofrinho Azul'),
    t(PW, '2026-11-18', -27, 'Dinheiro retirado'),
    t(PW, '2026-11-18', -26.5, 'Pix enviado Loja Exemplo'), // in Prumo
    t(PW, '2026-11-12', 280, 'Dinheiro retirado Cofrinho Pai'),
    t(PW, '2026-11-12', -280, 'Dinheiro retirado'),
    t(PW, '2026-11-12', -280, 'Pix enviado Fulano Exemplo'), // outside (ignored savings)
    t(PW, '2026-11-16', -680, 'Pix enviado Titular Exemplo'), // own transfer to the bank account
    t(PW, '2026-11-05', -118.4, 'Pagamento com Pix Internet Exemplo'), // missing in Prumo
  ],
  [PB]: [t(PB, '2026-11-16', 680, 'Transferência recebida Titular Exemplo')],
  [PCARD]: [t(PCARD, '2026-11-16', 47.3, 'Compra Exemplo 1/6')],
  [PINV]: [t(PINV, '2026-11-19', 4.28, 'RENDIMENTOS DE CLIENTES FUNDO11')],
};

function fakeClient(): PluggyClient {
  return {
    checkCredentials: vi.fn(async () => 'ok' as const),
    getItem: vi.fn(async (id: string) => (id === ITEM_X ? item(id, 'LOGIN_ERROR', 'USER_AUTHORIZATION_EXPIRED') : item(id))),
    listAccounts: vi.fn(async (id: string) =>
      id === ITEM_W ? [acc(PW, ITEM_W, 'BANK')] : id === ITEM_B ? [acc(PB, ITEM_B, 'BANK'), acc(PCARD, ITEM_B, 'CREDIT'), acc(PINV, ITEM_B, 'BANK')] : [acc(PX, ITEM_X, 'BANK')],
    ),
    listInvestments: vi.fn(async () => []),
    listTransactions: vi.fn(async (accountId: string) => TX[accountId] ?? []),
  };
}

function fakeDb() {
  const findLinks = vi.fn(async () => [
    { pluggyItemId: ITEM_W, pluggyAccountId: null, accountId: null },
    { pluggyItemId: ITEM_W, pluggyAccountId: PW, accountId: ACC_W },
    { pluggyItemId: ITEM_B, pluggyAccountId: PB, accountId: ACC_B },
    { pluggyItemId: ITEM_B, pluggyAccountId: PCARD, accountId: ACC_CARD },
    { pluggyItemId: ITEM_X, pluggyAccountId: PX, accountId: ACC_X },
    { pluggyItemId: ITEM_B, pluggyAccountId: PINV, accountId: ACC_INV },
  ]);
  const findTx = vi.fn(async () => [
    { id: 'p-pix', type: 'EXPENSE', accountId: ACC_W, fromAccountId: null, toAccountId: null, amount: '26.50', date: new Date('2026-11-18T00:00:00Z'), description: 'Loja', paid: true },
    { id: 'p-extra', type: 'EXPENSE', accountId: ACC_W, fromAccountId: null, toAccountId: null, amount: '99.00', date: new Date('2026-11-10T00:00:00Z'), description: 'Só no Prumo', paid: false },
  ]);
  const findAccounts = vi.fn(async () => [
    { id: ACC_W, type: 'CHECKING' },
    { id: ACC_B, type: 'CHECKING' },
    { id: ACC_CARD, type: 'CREDIT' },
    { id: ACC_X, type: 'CHECKING' },
    { id: ACC_INV, type: 'INVESTMENT' },
  ]);
  // The registered savings: the ignored one comes from here (no ?ignoreSavings= needed).
  const findSavings = vi.fn(async () => [
    { name: 'Cofrinho Azul', aliases: [], inPrumo: true, approxBalance: '100.00', balanceAsOf: new Date('2026-11-01T00:00:00Z') },
    { name: 'Cofrinho Pai', aliases: [], inPrumo: false, approxBalance: '900.00', balanceAsOf: new Date('2026-11-01T00:00:00Z') },
  ]);
  const db = {
    openFinanceLink: { findMany: findLinks },
    transaction: { findMany: findTx },
    account: { findMany: findAccounts },
    openFinanceSavings: { findMany: findSavings },
  };
  return { db: db as unknown as CheckDb, findTx };
}

describe('checkOpenFinance', () => {
  it('reports, per linked bank account, what Prumo already has and what is missing, without writing anything', async () => {
    const { db, findTx } = fakeDb();
    const client = fakeClient();

    const report = await checkOpenFinance({ householdId: HH, db, client, now: NOW, ignoredSavings: [] });

    expect(report.from).toBe('2026-10-27');
    expect(report.to).toBe('2026-11-26');
    // Prumo transactions are read for the linked accounts only, 3 days around the period.
    expect(findTx).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ householdId: HH, date: { gte: new Date('2026-10-24T00:00:00Z'), lte: new Date('2026-11-29T00:00:00Z') } }),
      }),
    );

    const wallet = report.accounts.find((a) => a.pluggyAccountId === PW)!;
    expect(wallet.prumoAccountId).toBe(ACC_W);
    expect(wallet.counts).toEqual({ yield: 3, savings: 4, outside: 1, passthrough: 0, matched: 1, missing: 1 });
    // Prumo's savings has 100 of 1.000 before the moves (10 %: 1 of 10 cents in October); after 280 left the ignored one
    // (12th) and 27 left ours (18th), 73 of 693 (10,5 %): 30 -> 3 and 25 -> 3 cents in November.
    expect(wallet.yieldsByMonth).toEqual([
      { month: '2026-10', cents: 10, prumoCents: 1 },
      { month: '2026-11', cents: 55, prumoCents: 6 },
    ]);
    expect(wallet.missing).toEqual([{ id: expect.any(String), date: '2026-11-05', cents: -11840, description: 'Pagamento com Pix Internet Exemplo', savingsName: null }]);
    expect(wallet.outside).toEqual([expect.objectContaining({ cents: -28000, savingsName: 'Cofrinho Pai' })]);
    expect(wallet.onlyInPrumo).toEqual([{ id: 'p-extra', type: 'EXPENSE', date: '2026-11-10', cents: 9900, description: 'Só no Prumo', paid: false }]);

    expect(report.transfers.missing).toEqual([
      { date: '2026-11-16', cents: 68000, fromPrumoAccountId: ACC_W, toPrumoAccountId: ACC_B, outDescription: 'Pix enviado Titular Exemplo', inDescription: 'Transferência recebida Titular Exemplo' },
    ]);
    expect(report.savingsNames).toEqual(['Cofrinho Azul', 'Cofrinho Pai']);

    // Cards are not checked here (their purchases come from the invoice OFX); the expired item is reported, not read.
    expect(report.cardsNotChecked).toBe(1);
    // The investment account belongs to the investments check (L5): not read here.
    expect(report.investmentsNotChecked).toBe(1);
    expect(client.listTransactions).not.toHaveBeenCalledWith(PINV, expect.anything());
    expect(client.listTransactions).not.toHaveBeenCalledWith(PCARD, expect.anything());
    expect(client.listTransactions).not.toHaveBeenCalledWith(PX, expect.anything());
    expect(report.items).toEqual(
      expect.arrayContaining([
        { itemId: ITEM_X, status: 'LOGIN_ERROR', blocked: 'A autorização deste banco venceu: reconecte no Meu Pluggy.' },
        { itemId: ITEM_W, status: 'UPDATED', blocked: null },
      ]),
    );
  });

  it('with no linked bank account it answers empty and reads no Prumo transaction', async () => {
    const db = { openFinanceLink: { findMany: vi.fn(async () => [{ pluggyItemId: ITEM_W, pluggyAccountId: null, accountId: null }]) }, transaction: { findMany: vi.fn() }, account: { findMany: vi.fn(async () => []) }, openFinanceSavings: { findMany: vi.fn(async () => []) } };
    const report = await checkOpenFinance({ householdId: HH, db: db as unknown as CheckDb, client: fakeClient(), now: NOW, ignoredSavings: [] });
    expect(report.accounts).toEqual([]);
    expect(db.transaction.findMany).not.toHaveBeenCalled();
  });
});
