import { describe, expect, it } from 'vitest';

import { classifyAccount, matchWithPrumo, pairOwnTransfers, type BankLine, type PrumoTx } from './open-finance.classify.js';
import type { PluggyTransaction } from './pluggy.client.js';

// Invented descriptions, ids and values only (the shapes follow what Meu Pluggy sent in the real preview).
const P_MAIN = 'prumo-main';
const P_OTHER = 'prumo-other';

let seq = 0;
const tx = (date: string, amount: number, description: string, accountId = 'pluggy-a'): PluggyTransaction => ({
  id: `t-${++seq}`,
  accountId,
  date,
  description,
  amount,
  type: amount < 0 ? 'DEBIT' : 'CREDIT',
  status: 'POSTED',
});

describe('classifyAccount', () => {
  it('daily yields are yields; savings moves (named or not) are internal; the rest are candidates', () => {
    const lines = classifyAccount(
      [
        tx('2026-11-20', 0.21, 'Rendimentos'),
        tx('2026-11-20', 15.4, 'Rendimentos'),
        tx('2026-11-21', 50, 'Dinheiro reservado'),
        tx('2026-11-21', -50, 'Dinheiro reservado Cofrinho Azul'),
        tx('2026-11-22', 40, 'Dinheiro retirado Cofrinho Azul'),
        tx('2026-11-22', -40, 'Dinheiro retirado'),
        tx('2026-11-22', -40, 'Pix enviado Loja Exemplo'),
      ],
      { prumoAccountId: P_MAIN, ignoredSavings: [] },
    );
    expect(lines.map((l) => l.kind)).toEqual(['yield', 'yield', 'savings', 'savings', 'savings', 'savings', 'candidate']);
    expect(lines[3].savingsName).toBe('Cofrinho Azul');
    expect(lines[6]).toMatchObject({ prumoAccountId: P_MAIN, cents: -4000, date: '2026-11-22' });
  });

  it('a payment made right after a withdrawal from an ignored savings is outside Prumo (accents and case do not matter)', () => {
    const lines = classifyAccount(
      [
        tx('2026-11-10', 300, 'Dinheiro retirado Cofrinho Pai'),
        tx('2026-11-10', -300, 'Dinheiro retirado'),
        tx('2026-11-10', -300, 'Pix enviado Fulano Exemplo'),
        tx('2026-11-11', -30, 'Pix enviado Outra Loja'),
        tx('2026-11-11', 29.5, 'Dinheiro retirado Cofrinho Azul'),
        tx('2026-11-11', -29.5, 'Dinheiro retirado'),
      ],
      { prumoAccountId: P_MAIN, ignoredSavings: ['cofrinho pái'] },
    );
    const byDesc = Object.fromEntries(lines.map((l) => [l.description, l]));
    expect(byDesc['Pix enviado Fulano Exemplo']).toMatchObject({ kind: 'outside', savingsName: 'Cofrinho Pai' });
    // Paid from a savings of Prumo (a few cents were already in the account): still a candidate, with its source.
    expect(byDesc['Pix enviado Outra Loja']).toMatchObject({ kind: 'candidate', savingsName: 'Cofrinho Azul' });
  });

  it('money received and put straight into an ignored savings is outside Prumo too', () => {
    const lines = classifyAccount(
      [
        tx('2026-11-17', 1983.84, 'Pix recebido Fulana Exemplo'),
        tx('2026-11-17', 1983.84, 'Dinheiro reservado'),
        tx('2026-11-17', -1983.84, 'Dinheiro reservado Cofrinho Pai'),
      ],
      { prumoAccountId: P_MAIN, ignoredSavings: ['Cofrinho Pai'] },
    );
    expect(lines[0]).toMatchObject({ kind: 'outside', savingsName: 'Cofrinho Pai' });
  });
});

const line = (over: Partial<BankLine>): BankLine => ({
  id: `l-${++seq}`,
  pluggyAccountId: 'pluggy-a',
  prumoAccountId: P_MAIN,
  date: '2026-11-16',
  cents: -1000,
  description: 'Pix',
  kind: 'candidate',
  savingsName: null,
  ...over,
});

describe('pairOwnTransfers', () => {
  it('an outflow and an inflow of the same value between two linked accounts (same day or next) become one transfer', () => {
    const out = line({ cents: -75000, prumoAccountId: P_MAIN, pluggyAccountId: 'pa' });
    const inn = line({ cents: 75000, prumoAccountId: P_OTHER, pluggyAccountId: 'pb', date: '2026-11-17' });
    const lonely = line({ cents: 75000, prumoAccountId: P_MAIN, pluggyAccountId: 'pa' });
    const { transfers, rest } = pairOwnTransfers([out, inn, lonely]);
    expect(transfers).toEqual([{ out, in: inn }]);
    expect(rest).toEqual([lonely]);
  });

  it('never pairs two lines of the same account, nor lines two days apart', () => {
    const a = line({ cents: -1000, pluggyAccountId: 'pa' });
    const b = line({ cents: 1000, pluggyAccountId: 'pa' });
    const c = line({ cents: 1000, pluggyAccountId: 'pb', prumoAccountId: P_OTHER, date: '2026-11-18' });
    expect(pairOwnTransfers([a, b, c]).transfers).toEqual([]);
  });
});

const prumo = (over: Partial<PrumoTx>): PrumoTx => ({
  id: `p-${++seq}`,
  type: 'EXPENSE',
  accountId: P_MAIN,
  fromAccountId: null,
  toAccountId: null,
  cents: 1000,
  date: '2026-11-16',
  description: 'Lançamento',
  paid: true,
  ...over,
});

describe('matchWithPrumo', () => {
  it('pairs each bank line with one Prumo transaction of the same account, kind and value, closest date within 3 days', () => {
    const out = line({ cents: -4590, date: '2026-11-16' });
    const income = line({ cents: 339389, date: '2026-11-05' });
    const far = prumo({ cents: 4590, date: '2026-11-13' });
    const near = prumo({ cents: 4590, date: '2026-11-15' });
    const salary = prumo({ type: 'INCOME', cents: 339389, date: '2026-11-05' });
    const wrongAccount = prumo({ cents: 4590, accountId: P_OTHER, date: '2026-11-16' });

    const result = matchWithPrumo({ lines: [out, income], transfers: [], prumo: [far, near, salary, wrongAccount], from: '2026-11-01', to: '2026-11-26' });

    expect(result.matched).toEqual([
      { line: out, transactionId: near.id },
      { line: income, transactionId: salary.id },
    ]);
    expect(result.missing).toEqual([]);
    expect(result.onlyInPrumo.map((p) => p.id)).toEqual([far.id, wrongAccount.id]);
  });

  it('an outflow may be a transfer out of the account (e.g. paying the card bill) and an inflow a transfer in', () => {
    const bill = line({ cents: -192255 });
    const t = prumo({ type: 'TRANSFER', accountId: null, fromAccountId: P_MAIN, toAccountId: 'card', cents: 192255 });
    const result = matchWithPrumo({ lines: [bill], transfers: [], prumo: [t], from: '2026-11-01', to: '2026-11-26' });
    expect(result.matched).toEqual([{ line: bill, transactionId: t.id }]);
  });

  it('a pair between own accounts matches one Prumo transfer between the two accounts; else it is missing as a transfer', () => {
    const out = line({ cents: -75000, prumoAccountId: P_MAIN });
    const inn = line({ cents: 75000, prumoAccountId: P_OTHER });
    const t = prumo({ type: 'TRANSFER', accountId: null, fromAccountId: P_MAIN, toAccountId: P_OTHER, cents: 75000 });

    const ok = matchWithPrumo({ lines: [], transfers: [{ out, in: inn }], prumo: [t], from: '2026-11-01', to: '2026-11-26' });
    expect(ok.matchedTransfers).toEqual([{ transfer: { out, in: inn }, transactionId: t.id }]);

    const none = matchWithPrumo({ lines: [], transfers: [{ out, in: inn }], prumo: [], from: '2026-11-01', to: '2026-11-26' });
    expect(none.missingTransfers).toEqual([{ out, in: inn }]);
  });

  it('a value that differs by one cent is not the same transaction (bank lines match to the cent)', () => {
    const out = line({ cents: -26217 });
    const result = matchWithPrumo({ lines: [out], transfers: [], prumo: [prumo({ cents: 26216 })], from: '2026-11-01', to: '2026-11-26' });
    expect(result.missing).toEqual([out]);
  });

  it('Prumo transactions outside the bank period are not reported as only in Prumo', () => {
    const result = matchWithPrumo({
      lines: [],
      transfers: [],
      prumo: [prumo({ date: '2026-10-29' }), prumo({ date: '2026-11-30' })],
      from: '2026-11-01',
      to: '2026-11-26',
    });
    expect(result.onlyInPrumo).toEqual([]);
  });
});
