import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesWhere, type Row } from '../../shared/__fixtures__/where-eval.js';

// "One account only": the budget summary, "Para onde vai a renda" (P05) and "crédito × débito" (P18) read the same rows
// (budgetSpendingWhere) with the same own-share rule, so a refund lowers all three by the same amount. Invented data.
const HH = 'hh-1';
const CARD = 'acc-card';
const CHECKING = 'acc-checking';
const OCT = new Date(Date.UTC(2026, 9, 1));
const store = vi.hoisted(() => ({
  transactions: [] as Array<Record<string, unknown>>,
  shares: [] as Array<Record<string, unknown>>,
  budgets: [] as Array<Record<string, unknown>>,
  accounts: [] as Array<Record<string, unknown>>,
}));
const dec = (n: number) => ({ toNumber: () => n, valueOf: () => n });

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    transaction: {
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }) =>
        store.transactions.filter((r) => matchesWhere(r as Row, args.where)).map((r) => ({ ...r, amount: dec(r.amount as number), date: new Date(`${r.date}T00:00:00.000Z`) }))),
    },
    transactionShare: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> & { transaction: Record<string, unknown> } }) => {
        const { transaction, ...own } = args.where;
        return store.shares
          .filter((s) => matchesWhere(s as Row, own))
          .map((s) => ({ s, tx: store.transactions.find((t) => t.id === s.transactionId) }))
          .filter(({ tx }) => tx && matchesWhere(tx as Row, transaction))
          .map(({ s, tx }) => ({
            transactionId: s.transactionId,
            amount: dec(s.amount as number),
            transaction: { amount: dec(tx!.amount as number), categoryName: tx!.categoryName, isRefund: tx!.isRefund === true, type: tx!.type },
          }));
      }),
    },
    account: { findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => store.accounts.filter((a) => matchesWhere(a as Row, args.where))) },
    budget: { findMany: vi.fn(async () => store.budgets.map((b) => ({ ...b, monthlyLimit: dec(b.monthlyLimit as number) }))) },
  },
}));

const { loadSpendingByMethod } = await import('./spending-by-method.loader.js');
const { realizedByCategory } = await import('./income-split.loader.js');
const { getBudgetSummary } = await import('../budgets/budgets.service.js');

let seq = 0;
function tx(over: Record<string, unknown> = {}) {
  seq += 1;
  const row = { id: `t-${seq}`, householdId: HH, type: 'EXPENSE', categoryName: 'FOOD', amount: -100, date: '2026-10-05', competenceMonth: null, isRefund: false, accountId: CHECKING, attachmentUrl: null, ...over };
  store.transactions.push(row);
  return row.id as string;
}
const refund = (over: Record<string, unknown> = {}) => tx({ type: 'INCOME', isRefund: true, amount: 100, date: '2026-10-12', ...over });
const share = (transactionId: string, amount: number) =>
  store.shares.push({ id: `s-${store.shares.length}`, householdId: HH, transactionId, direction: 'THEY_OWE_ME', amount });

/** The three reports for October, in reais: the General budget (own share), the split's realized total, the method total. */
async function figures() {
  const summary = await getBudgetSummary({ householdId: HH, month: '2026-10' } as never);
  const general = summary.budgets.find((b) => b.categoryName === 'GENERAL')!;
  const realized = await realizedByCategory(HH, '2026-10');
  const realizedTotal = [...realized.values()].reduce((a, b) => a + b, 0) / 100;
  const method = await loadSpendingByMethod({ householdId: HH, months: 1, to: '2026-10', today: new Date(Date.UTC(2026, 9, 20)) });
  return { spending: general.spending, ownSpent: general.ownSpent, realizedTotal, methodTotal: method.totals.total, method: method.months[0]! };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.transactions = [];
  store.shares = [];
  store.budgets = [{ id: 'b-g', householdId: HH, categoryName: 'GENERAL', monthlyLimit: 1000, month: OCT, endMonth: null, type: 'EXPENSE', measure: 'WHOLE', createdAt: OCT, updatedAt: OCT }];
  store.accounts = [
    { id: CARD, householdId: HH, type: 'CREDIT', isActive: true },
    { id: CHECKING, householdId: HH, type: 'CHECKING', isActive: true },
  ];
  seq = 0;
});

describe('a refund lowers the three reports by the same amount', () => {
  it('purchase of 100 and refund of 100: zero in the budget, in the income split and in credit × debit (not 200)', async () => {
    tx({ amount: -100 });
    refund();
    const f = await figures();
    expect([f.spending, f.ownSpent, f.realizedTotal, f.methodTotal]).toEqual([0, 0, 0, 0]);
  });

  it('purchase of 100 and refund of 30: all three say 70', async () => {
    tx({ amount: -100 });
    refund({ amount: 30 });
    const f = await figures();
    expect([f.spending, f.ownSpent, f.realizedTotal, f.methodTotal]).toEqual([70, 70, 70, 70]);
  });

  it('a refund on the card lowers the credit side of credit × debit', async () => {
    tx({ amount: -100, accountId: CARD });
    tx({ amount: -40 });
    refund({ amount: 30, accountId: CARD });
    const f = await figures();
    expect(f.method).toMatchObject({ credit: 70, other: 40, total: 110 });
    expect(f.realizedTotal).toBe(110);
    expect(f.spending).toBe(110);
  });

  it('a refund of a purchase of an earlier month leaves the month negative in all three', async () => {
    refund({ amount: 30 });
    const f = await figures();
    expect([f.spending, f.ownSpent, f.realizedTotal, f.methodTotal]).toEqual([-30, -30, -30, -30]);
    expect(f.method.creditShare).toBeNull();
  });

  it('a divided purchase and its refund divided the same way: the own part nets to zero', async () => {
    const bought = tx({ amount: -100 });
    share(bought, 50);
    const back = refund();
    share(back, 50);
    const f = await figures();
    expect([f.spending, f.ownSpent, f.realizedTotal, f.methodTotal]).toEqual([0, 0, 0, 0]);
  });

  it('a divided purchase with 50 of another person, refunded in full with no division: own 50 - 100 = -50 (no link between them)', async () => {
    share(tx({ amount: -100 }), 50);
    refund();
    const f = await figures();
    // Without a link the refund is the user's own money back: documented rule, the same in the three reports
    expect([f.spending, f.ownSpent, f.realizedTotal, f.methodTotal]).toEqual([0, -50, -50, -50]);
  });

  it('a divided refund of an undivided purchase: own 100 - 50 = 50', async () => {
    tx({ amount: -100 });
    share(refund(), 50);
    const f = await figures();
    expect([f.ownSpent, f.realizedTotal, f.methodTotal]).toEqual([50, 50, 50]);
  });
});
