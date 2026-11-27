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
        tx('2026-11-10', 260, 'Dinheiro retirado Cofrinho Pai'),
        tx('2026-11-10', -260, 'Dinheiro retirado'),
        tx('2026-11-10', -260, 'Pix enviado Fulano Exemplo'),
        tx('2026-11-11', -41, 'Pix enviado Outra Loja'),
        tx('2026-11-11', 40.5, 'Dinheiro retirado Cofrinho Azul'),
        tx('2026-11-11', -40.5, 'Dinheiro retirado'),
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
        tx('2026-11-17', 1871.2, 'Pix recebido Fulana Exemplo'),
        tx('2026-11-17', 1871.2, 'Dinheiro reservado'),
        tx('2026-11-17', -1871.2, 'Dinheiro reservado Cofrinho Pai'),
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
    const out = line({ cents: -68000, prumoAccountId: P_MAIN, pluggyAccountId: 'pa' });
    const inn = line({ cents: 68000, prumoAccountId: P_OTHER, pluggyAccountId: 'pb', date: '2026-11-17' });
    const lonely = line({ cents: 68000, prumoAccountId: P_MAIN, pluggyAccountId: 'pa' });
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
    const income = line({ cents: 287650, date: '2026-11-05' });
    const far = prumo({ cents: 4590, date: '2026-11-13' });
    const near = prumo({ cents: 4590, date: '2026-11-15' });
    const salary = prumo({ type: 'INCOME', cents: 287650, date: '2026-11-05' });
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
    const bill = line({ cents: -143380 });
    const t = prumo({ type: 'TRANSFER', accountId: null, fromAccountId: P_MAIN, toAccountId: 'card', cents: 143380 });
    const result = matchWithPrumo({ lines: [bill], transfers: [], prumo: [t], from: '2026-11-01', to: '2026-11-26' });
    expect(result.matched).toEqual([{ line: bill, transactionId: t.id }]);
  });

  it('a pair between own accounts matches one Prumo transfer between the two accounts; else it is missing as a transfer', () => {
    const out = line({ cents: -68000, prumoAccountId: P_MAIN });
    const inn = line({ cents: 68000, prumoAccountId: P_OTHER });
    const t = prumo({ type: 'TRANSFER', accountId: null, fromAccountId: P_MAIN, toAccountId: P_OTHER, cents: 68000 });

    const ok = matchWithPrumo({ lines: [], transfers: [{ out, in: inn }], prumo: [t], from: '2026-11-01', to: '2026-11-26' });
    expect(ok.matchedTransfers).toEqual([{ transfer: { out, in: inn }, transactionId: t.id }]);

    const none = matchWithPrumo({ lines: [], transfers: [{ out, in: inn }], prumo: [], from: '2026-11-01', to: '2026-11-26' });
    expect(none.missingTransfers).toEqual([{ out, in: inn }]);
  });

  it('a value that differs by one cent is not the same transaction (bank lines match to the cent)', () => {
    const out = line({ cents: -31533 });
    const result = matchWithPrumo({ lines: [out], transfers: [], prumo: [prumo({ cents: 31532 })], from: '2026-11-01', to: '2026-11-26' });
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

describe('rules adjusted after the first real check (27/11/2026)', () => {
  it('only a line that is exactly "Rendimentos" is a savings yield; fund income with that word is a candidate', () => {
    const lines = classifyAccount(
      [tx('2026-11-20', 0.2, 'Rendimentos'), tx('2026-11-19', 4.28, 'RENDIMENTOS DE CLIENTES FUNDO11 S/ 100')],
      { prumoAccountId: P_MAIN, ignoredSavings: [] },
    );
    expect(lines.map((l) => l.kind)).toEqual(['yield', 'candidate']);
  });

  it('a payment from an ignored savings is outside even when more was withdrawn than paid (the rest stays)', () => {
    const lines = classifyAccount(
      [
        tx('2026-11-12', 410, 'Dinheiro retirado Cofrinho Pai'),
        tx('2026-11-12', -410, 'Dinheiro retirado'),
        tx('2026-11-12', -380, 'Pix enviado Fulano Exemplo'),
      ],
      { prumoAccountId: P_MAIN, ignoredSavings: ['Cofrinho Pai'] },
    );
    expect(lines[2]).toMatchObject({ kind: 'outside', savingsName: 'Cofrinho Pai' });
  });

  it('money that enters and leaves the same account on the same day with the same value is a pass-through (both lines)', () => {
    const lines = classifyAccount(
      [
        tx('2026-11-16', 680, 'Transferência recebida Fulana'),
        tx('2026-11-16', -680, 'Transferência enviada pelo Pix'),
        tx('2026-11-16', 13.02, 'Pix recebido Titular'),
        tx('2026-11-16', -13, 'Pix enviado Titular'),
        tx('2026-11-17', -680, 'Transferência enviada pelo Pix'),
      ],
      { prumoAccountId: P_MAIN, ignoredSavings: [] },
    );
    expect(lines.map((l) => l.kind)).toEqual(['passthrough', 'passthrough', 'candidate', 'candidate', 'candidate']);
  });

  it('matching falls back to the same value in the same month when no Prumo transaction is within 3 days', () => {
    const bill = line({ cents: -11840, date: '2026-11-05' });
    const monthly = prumo({ cents: 11840, date: '2026-11-01' });
    const otherMonth = prumo({ cents: 11840, date: '2026-10-01' });
    const result = matchWithPrumo({ lines: [bill], transfers: [], prumo: [otherMonth, monthly], from: '2026-10-28', to: '2026-11-27' });
    expect(result.matched).toEqual([{ line: bill, transactionId: monthly.id }]);
  });

  it('the 3-day window wins over the same-month fallback', () => {
    const out = line({ cents: -5000, date: '2026-11-20' });
    const sameMonth = prumo({ cents: 5000, date: '2026-11-02' });
    const near = prumo({ cents: 5000, date: '2026-11-21' });
    const result = matchWithPrumo({ lines: [out], transfers: [], prumo: [sameMonth, near], from: '2026-10-28', to: '2026-11-27' });
    expect(result.matched[0].transactionId).toBe(near.id);
  });
});

describe('pass-through, second real check (27/11/2026)', () => {
  it('money in and out of the same account on consecutive days is a pass-through too (same day first)', () => {
    const lines = classifyAccount(
      [tx('2026-10-28', 260, 'Transferência recebida'), tx('2026-10-29', -260, 'Transferência enviada pelo Pix'), tx('2026-10-31', -260, 'Transferência enviada pelo Pix')],
      { prumoAccountId: P_MAIN, ignoredSavings: [] },
    );
    expect(lines.map((l) => l.kind)).toEqual(['passthrough', 'passthrough', 'candidate']);
  });

  it('a pass-through that Prumo has as transfers (a round trip registered by hand) is matched, not "only in Prumo"', () => {
    const out = line({ cents: -1000, kind: 'passthrough', date: '2026-11-15' });
    const inn = line({ cents: 1000, kind: 'passthrough', date: '2026-11-15' });
    const go = prumo({ type: 'TRANSFER', accountId: null, fromAccountId: P_MAIN, toAccountId: P_OTHER, cents: 1000, date: '2026-11-15' });
    const back = prumo({ type: 'TRANSFER', accountId: null, fromAccountId: P_OTHER, toAccountId: P_MAIN, cents: 1000, date: '2026-11-15' });

    const result = matchWithPrumo({ lines: [], passthrough: [out, inn], transfers: [], prumo: [go, back], from: '2026-11-01', to: '2026-11-27' });

    expect(result.onlyInPrumo).toEqual([]);
    expect(result.matchedPassthrough).toEqual([
      { line: out, transactionId: go.id },
      { line: inn, transactionId: back.id },
    ]);
  });

  it('a pass-through never takes an expense or an income of Prumo (only transfers)', () => {
    const out = line({ cents: -1000, kind: 'passthrough' });
    const expense = prumo({ cents: 1000 });
    const result = matchWithPrumo({ lines: [], passthrough: [out], transfers: [], prumo: [expense], from: '2026-11-01', to: '2026-11-27' });
    expect(result.matchedPassthrough).toEqual([]);
    expect(result.onlyInPrumo).toEqual([expense]);
  });
});
