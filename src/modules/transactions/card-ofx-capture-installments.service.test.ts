import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fakeServices,
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

// P22 L2: a purchase confirmed from a capture in 3x leaves three card transactions (installment 1 with the capture's
// `notif:<dedupKey>`, the others with `notif:<dedupKey>:f<i>`). The card invoice OFX import must recognise them: the
// line of installment 1 enriches the first one, the line of installment 2 (next statement) adopts the second, and
// no second set of installments is ever generated. Invented store and amounts only.

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

const SEPTEMBER_STATEMENT = (trns: Trn[]) => ofx(trns, '20260902', '20261002');
const OCTOBER_STATEMENT = (trns: Trn[]) => ofx(trns, '20261003', '20261102');

function seedCard(): ResolvedCardAccount {
  const card = seedAccount({ id: CARD, householdId: HH, name: 'Cartao Teste', type: 'CREDIT', dueDay: 9, closingDay: 2 });
  return { id: card.id, name: card.name, type: 'CREDIT' as ResolvedCardAccount['type'], householdId: HH, dueDay: card.dueDay, closingDay: card.closingDay };
}

/** What POST /captures/:id/confirm leaves behind for 100,00 in 3x on 15/09: 33,34 + 33,33 + 33,33, one per month. */
function seedCapturedPlan(): FakeTransaction[] {
  const base = {
    householdId: HH, accountId: CARD, type: 'EXPENSE' as const, categoryName: 'SHOPPING', description: 'Loja Exemplo', paid: true,
    installmentId: PLAN, totalInstallments: 3,
  };
  return [
    seedTransaction({ ...base, amount: 33.34, date: '2026-09-15', sourceRef: PLAN, installmentNumber: 1 }),
    seedTransaction({ ...base, amount: 33.33, date: '2026-10-15', sourceRef: `${PLAN}:f1`, installmentNumber: 2 }),
    seedTransaction({ ...base, amount: 33.33, date: '2026-11-15', sourceRef: `${PLAN}:f2`, installmentNumber: 3 }),
  ];
}

const tx = (id: string) => store.transactions.find((t) => t.id === id)!;
const refsOf = (id: string) => store.refs.filter((r) => r.transactionId === id).map((r) => r.ref).sort();
const onCard = () => store.transactions.filter((t) => t.accountId === CARD);

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

describe('card OFX import: purchases confirmed from a capture in installments (P22)', () => {
  let card: ResolvedCardAccount;
  beforeEach(() => {
    card = seedCard();
  });

  it('the statement with installment 1 enriches the captured installment and generates no second set of installments', async () => {
    const [first] = seedCapturedPlan();
    const buffer = SEPTEMBER_STATEMENT([{ fitid: 'fit-x', date: '20260915', amount: '-33.34', memo: 'Loja Exemplo - Parcela 1/3' }]);

    const preview = await buildCardOfxPreview({ account: card, buffer });

    expect(preview.proposals.map((p) => p.kind)).toEqual(['enrich-exact']);
    expect(preview.proposals[0]!.target).toMatchObject({ transactionId: first!.id, sourceRef: PLAN });

    const result = await confirmCardOfxImport({ request: confirmRequest(preview), account: card, userId: 'user-1' });

    expect(result).toMatchObject({ enriched: 1, created: 0, skipped: 0 });
    expect(result.futureInstallments ?? 0).toBe(0);
    expect(onCard()).toHaveLength(3);
    expect(tx(first!.id)).toMatchObject({ sourceRef: PLAN, installmentId: PLAN, installmentNumber: 1, totalInstallments: 3, description: 'Loja Exemplo - Parcela 1/3' });
    expect(refsOf(first!.id)[0]).toMatch(/^ofx:fit-x:/);
  });

  it('the next statement, with installment 2, adopts the captured future instead of creating another', async () => {
    const [, second] = seedCapturedPlan();
    const buffer = OCTOBER_STATEMENT([{ fitid: 'fit-x', date: '20261015', amount: '-33.33', memo: 'Loja Exemplo - Parcela 2/3' }]);

    const preview = await buildCardOfxPreview({ account: card, buffer });

    expect(preview.proposals.map((p) => p.kind)).toEqual(['consume-future']);
    expect(preview.proposals[0]!.target).toMatchObject({ transactionId: second!.id, sourceRef: `${PLAN}:f1` });

    const result = await confirmCardOfxImport({ request: confirmRequest(preview), account: card, userId: 'user-1' });

    expect(result).toMatchObject({ created: 0, skipped: 0 });
    expect(result.futureInstallments ?? 0).toBe(0);
    expect(onCard()).toHaveLength(3);
    expect(tx(second!.id)).toMatchObject({ sourceRef: `${PLAN}:f1`, installmentId: PLAN, installmentNumber: 2, description: 'Loja Exemplo - Parcela 2/3' });
    expect(refsOf(second!.id)[0]).toMatch(/^ofx:fit-x:/);
  });

  it('a captured future is never taken for a plain notification: an unrelated line of the same amount stays new', async () => {
    const [, second] = seedCapturedPlan();
    const buffer = OCTOBER_STATEMENT([
      { fitid: 'fit-other', date: '20261015', amount: '-33.33', memo: 'Mercado Zeta' },
      { fitid: 'fit-x', date: '20261015', amount: '-33.33', memo: 'Loja Exemplo - Parcela 2/3' },
    ]);

    const preview = await buildCardOfxPreview({ account: card, buffer });

    const consume = preview.proposals.find((p) => p.kind === 'consume-future')!;
    expect(consume.target).toMatchObject({ transactionId: second!.id });
    expect(preview.proposals.filter((p) => p.target?.transactionId === second!.id)).toHaveLength(1);
    expect(preview.proposals.filter((p) => p.kind === 'enrich-exact')).toEqual([]);
    expect(preview.proposals.filter((p) => p.kind === 'create')).toHaveLength(1);
    expect(fakeServices.createTransaction).not.toHaveBeenCalled();
  });

  it('installment 1 charged 1 cent below the stored one (33,33 vs 33,34) still pairs: the row takes the bank value and no future is generated', async () => {
    const [first, second] = seedCapturedPlan();
    const buffer = SEPTEMBER_STATEMENT([{ fitid: 'fit-x', date: '20260915', amount: '-33.33', memo: 'Loja Exemplo - Parcela 1/3' }]);

    const preview = await buildCardOfxPreview({ account: card, buffer });

    expect(preview.proposals.map((p) => p.kind)).toEqual(['enrich-near']);
    expect(preview.proposals[0]).toMatchObject({ defaultSelected: true });
    expect(preview.proposals[0]!.target).toMatchObject({ transactionId: first!.id, sourceRef: PLAN });

    const result = await confirmCardOfxImport({ request: confirmRequest(preview), account: card, userId: 'user-1' });

    expect(result).toMatchObject({ enriched: 1, created: 0, skipped: 0 });
    expect(result.futureInstallments ?? 0).toBe(0);
    expect(onCard()).toHaveLength(3);
    expect(tx(first!.id)).toMatchObject({ sourceRef: PLAN, installmentId: PLAN, installmentNumber: 1, totalInstallments: 3, amount: 33.33, description: 'Loja Exemplo - Parcela 1/3' });
    expect(refsOf(first!.id)[0]).toMatch(/^ofx:fit-x:/);

    // the next statement adopts the captured installment 2 (:f1), still nothing new
    const next = OCTOBER_STATEMENT([{ fitid: 'fit-y', date: '20261015', amount: '-33.33', memo: 'Loja Exemplo - Parcela 2/3' }]);
    const nextPreview = await buildCardOfxPreview({ account: card, buffer: next });
    expect(nextPreview.proposals.map((p) => p.kind)).toEqual(['consume-future']);
    expect(nextPreview.proposals[0]!.target).toMatchObject({ transactionId: second!.id });
    await confirmCardOfxImport({ request: confirmRequest(nextPreview), account: card, userId: 'user-1' });
    expect(onCard()).toHaveLength(3);
  });

  it('installment 1 charged 3 cents away (above the 2 left over by the division in 3) does not pair with the captured one', async () => {
    const [first] = seedCapturedPlan();
    const buffer = SEPTEMBER_STATEMENT([{ fitid: 'fit-x', date: '20260915', amount: '-33.31', memo: 'Loja Exemplo - Parcela 1/3' }]);

    const preview = await buildCardOfxPreview({ account: card, buffer });

    expect(preview.proposals.filter((p) => p.target?.transactionId === first!.id)).toEqual([]);
    expect(preview.proposals.map((p) => p.kind)).toEqual(['create']);
  });

  it('the tolerance is only for installment 1 of a captured plan: a plain notification 1 cent apart is not paired', async () => {
    const plain = seedTransaction({
      householdId: HH, accountId: CARD, type: 'EXPENSE', categoryName: 'SHOPPING', description: 'Loja Exemplo', paid: true,
      amount: 33.34, date: '2026-09-15', sourceRef: `notif:${'b2'.repeat(20)}`,
    });
    const buffer = SEPTEMBER_STATEMENT([{ fitid: 'fit-x', date: '20260915', amount: '-33.33', memo: 'Loja Exemplo' }]);

    const preview = await buildCardOfxPreview({ account: card, buffer });

    expect(preview.proposals.filter((p) => p.target?.transactionId === plain.id)).toEqual([]);
  });
});
