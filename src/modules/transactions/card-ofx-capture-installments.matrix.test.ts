import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetStore,
  seedAccount,
  seedTransaction,
  store,
  type FakeTransaction,
} from './__fixtures__/card-ofx-fake-db.js';
import { buildCardOfxPreview, confirmCardOfxImport, type ResolvedCardAccount } from './card-ofx-import.service.js';
import type { CardOfxConfirmRequest, CardOfxPreviewResponse } from './card-ofx-import.types.js';

vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('./__fixtures__/card-ofx-fake-db.js')).fakePrisma,
}));
vi.mock('./transactions.service.js', async () => {
  const { fakeServices: s } = await import('./__fixtures__/card-ofx-fake-db.js');
  return {
    createTransaction: s.createTransaction,
    deleteTransaction: s.deleteTransaction,
    updateTransaction: s.updateTransaction,
    payCreditCardInvoice: s.payCreditCardInvoice,
    undoCreditCardPayment: s.undoCreditCardPayment,
  };
});
vi.mock('../categories/categories.service.js', async () => ({
  createCategory: (await import('./__fixtures__/card-ofx-fake-db.js')).fakeServices.createCategory,
}));

// P22 L2, regression guard: "the card invoice OFX import must never duplicate a purchase that came from a capture in
// installments". A matrix of how the bank splits the cents x how the capture stored them x the statements imported
// (month of installment 1, then 2, then 3). The assertions are the INVARIANT, not the detail: after the imports there is
// ONE plan (as many rows as installments, no `ofx:` purchase, no `ofx:...:f<i>` future) and the card holds what the bank
// charged. A gap above the tolerance must still NOT pair. Invented store and amounts only.

const HH = 'hh-1';
const CARD = 'card-1';
const KEY = 'a1'.repeat(20);
const PLAN = `notif:${KEY}`;

interface Trn { fitid: string; date: string; amount: string; memo: string }

function ofx(trns: Trn[], start: string, end: string): Buffer {
  const body = trns
    .map(
      (t) =>
        `<STMTTRN>\n<TRNTYPE>${t.amount.startsWith('-') ? 'DEBIT' : 'CREDIT'}</TRNTYPE>\n<DTPOSTED>${t.date}000000[-3:BRT]</DTPOSTED>\n` +
        `<TRNAMT>${t.amount}</TRNAMT>\n<FITID>${t.fitid}</FITID>\n<MEMO>${t.memo}</MEMO>\n</STMTTRN>`,
    )
    .join('\n');
  return Buffer.from(
    [
      'OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'CHARSET:1252', '<OFX>',
      '<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>', '<BANKTRANLIST>',
      `<DTSTART>${start}000000[-3:BRT]</DTSTART>`, `<DTEND>${end}000000[-3:BRT]</DTEND>`,
      body, '</BANKTRANLIST>', '</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>', '</OFX>',
    ].join('\n'),
    'utf8',
  );
}

const STATEMENTS = [
  (t: Trn[]) => ofx(t, '20260902', '20261002'),
  (t: Trn[]) => ofx(t, '20261003', '20261102'),
  (t: Trn[]) => ofx(t, '20261103', '20261202'),
];
const MONTH_DATES = ['20260915', '20261015', '20261115'];

function seedCard(): ResolvedCardAccount {
  const card = seedAccount({ id: CARD, householdId: HH, name: 'Cartao Teste', type: 'CREDIT', dueDay: 9, closingDay: 2 });
  return { id: card.id, name: card.name, type: 'CREDIT' as ResolvedCardAccount['type'], householdId: HH, dueDay: card.dueDay, closingDay: card.closingDay };
}

/** How the capture stored the plan: `auto` = remainder on installment 1; `corrected` = the user typed one amount for all. */
function storedCents(total: number, n: number, mode: 'auto' | 'corrected'): number[] {
  const base = Math.floor(total / n);
  const rest = total - base * n;
  if (mode === 'corrected') return Array.from({ length: n }, () => Math.round(total / n));
  return Array.from({ length: n }, (_, i) => (i === 0 ? base + rest : base));
}

/** How the bank charges it. */
function bankCents(total: number, n: number, mode: 'rest-first' | 'rest-last' | 'all-equal'): number[] {
  const base = Math.floor(total / n);
  const rest = total - base * n;
  if (mode === 'all-equal') return Array.from({ length: n }, () => Math.round(total / n));
  return Array.from({ length: n }, (_, i) => (mode === 'rest-first' ? (i === 0 ? base + rest : base) : i === n - 1 ? base + rest : base));
}

function seedPlan(cents: number[]): FakeTransaction[] {
  const n = cents.length;
  return cents.map((c, i) =>
    seedTransaction({
      householdId: HH, accountId: CARD, type: 'EXPENSE' as const, categoryName: 'SHOPPING', description: 'Loja Exemplo', paid: true,
      installmentId: PLAN, totalInstallments: n, installmentNumber: i + 1, amount: c / 100,
      date: `${2026 + Math.floor((8 + i) / 12)}-${String(((8 + i) % 12) + 1).padStart(2, '0')}-15`,
      sourceRef: i === 0 ? PLAN : `${PLAN}:f${i}`,
    }),
  );
}

const refsOf = (id: string) => store.refs.filter((r) => r.transactionId === id).map((r) => r.ref).sort();
const cardRows = () => store.transactions.filter((t) => t.accountId === CARD);
const centsOf = (t: FakeTransaction) => Math.round(Number(t.amount) * 100);
const fmt = (cents: number) => `-${(cents / 100).toFixed(2)}`;

function confirmRequest(preview: CardOfxPreviewResponse): CardOfxConfirmRequest {
  return {
    accountId: preview.accountId,
    monthKey: preview.monthKey,
    lines: preview.lines.map(({ status: _status, group: _group, ...line }) => line),
    ledgerBalance: preview.ledgerBalance,
    paymentLineRef: preview.payment?.ref ?? null,
    selectedGroups: preview.proposals.filter((p) => p.defaultSelected).map((p) => p.group),
    categoryMap: preview.categoryMap.map((entry) => ({ key: entry.key, type: entry.type, target: { kind: 'default' as const } })),
    payment: { apply: true },
  };
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

const TOTALS: Array<[string, number, number]> = [
  ['100,00 in 3x', 10000, 3],
  ['10,00 in 3x', 1000, 3],
  ['99,99 in 7x', 9999, 7],
  ['1.000,00 in 24x', 100000, 24],
];
const STORED_MODES = ['auto', 'corrected'] as const;
const BANK_MODES = ['rest-first', 'rest-last', 'all-equal'] as const;

describe('regression guard: the card OFX import never duplicates a purchase captured in installments (P22)', () => {
  let card: ResolvedCardAccount;
  beforeEach(() => {
    card = seedCard();
  });

  const scenarios = TOTALS.flatMap(([label, total, n]) =>
    STORED_MODES.flatMap((stored) => BANK_MODES.map((bank) => ({ name: `${label} | stored ${stored} | bank ${bank}`, total, n, stored, bank }))),
  );

  it.each(scenarios)('$name: one plan, no ofx purchase or future, the card holds what the bank charged', async ({ total, n, stored, bank }) => {
    seedPlan(storedCents(total, n, stored));
    const charged = bankCents(total, n, bank);
    const imported = Math.min(n, 3);

    for (let m = 0; m < imported; m++) {
      const preview = await buildCardOfxPreview({
        account: card,
        buffer: STATEMENTS[m]!([{ fitid: 'fit-x', date: MONTH_DATES[m]!, amount: fmt(charged[m]!), memo: `Loja Exemplo - Parcela ${m + 1}/${n}` }]),
      });
      // Nothing of this purchase is ever proposed as new.
      expect(preview.proposals.filter((p) => p.kind === 'create'), `statement ${m + 1}`).toEqual([]);
      const result = await confirmCardOfxImport({ request: confirmRequest(preview), account: card, userId: 'user-1' });
      expect(result.created, `statement ${m + 1}`).toBe(0);
      expect(result.skipped, `statement ${m + 1}`).toBe(0);
      expect(result.futureInstallments ?? 0, `statement ${m + 1}`).toBe(0);
    }

    const rows = cardRows();
    expect(rows).toHaveLength(n);
    expect(rows.filter((r) => (r.sourceRef ?? '').startsWith('ofx:'))).toEqual([]);
    expect(new Set(rows.map((r) => r.installmentId))).toEqual(new Set([PLAN]));
    expect(rows.map((r) => r.installmentNumber).sort((a, b) => Number(a) - Number(b))).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    const byNumber = (k: number) => rows.find((r) => r.installmentNumber === k)!;
    const importedSum = Array.from({ length: imported }, (_, i) => centsOf(byNumber(i + 1))).reduce((a, b) => a + b, 0);
    expect(importedSum).toBe(charged.slice(0, imported).reduce((a, b) => a + b, 0));
    for (let m = 0; m < imported; m++) expect(refsOf(byNumber(m + 1).id)[0]).toMatch(/^ofx:fit-x:/);

    // Importing the first statement again: everything is reconciled, still one plan.
    const again = await buildCardOfxPreview({
      account: card,
      buffer: STATEMENTS[0]!([{ fitid: 'fit-x', date: MONTH_DATES[0]!, amount: fmt(charged[0]!), memo: `Loja Exemplo - Parcela 1/${n}` }]),
    });
    expect(again.proposals).toEqual([]);
    expect(cardRows()).toHaveLength(n);
  });

  it.each(TOTALS)('%s: installment 1 charged above the tolerance (n cents apart) does not pair, so the tolerance is not "pair anything"', async (_label, total, n) => {
    const plan = seedPlan(storedCents(total, n, 'auto'));
    const farther = centsOf(plan[0]!) + n;
    const preview = await buildCardOfxPreview({
      account: card,
      buffer: STATEMENTS[0]!([{ fitid: 'fit-x', date: MONTH_DATES[0]!, amount: fmt(farther), memo: `Loja Exemplo - Parcela 1/${n}` }]),
    });
    expect(preview.proposals.filter((p) => p.target?.transactionId === plan[0]!.id)).toEqual([]);
    expect(preview.proposals.map((p) => p.kind)).toContain('create');
  });
});
