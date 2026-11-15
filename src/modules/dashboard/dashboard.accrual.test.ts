import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesWhere, type Row } from '../../shared/__fixtures__/where-eval.js';
import { GENERAL_BUDGET_CATEGORY } from '../../shared/enums/index.js';

// The dashboard follows the accrual rule of the budgets: a card purchase counts in its own month and the payment of
// the invoice does not count as spending. The dashboard and the budget summary must show the same figure for the
// same data. Invented data only; the fake database runs the real `where` of each query.
const HH = 'hh-1';
const store = vi.hoisted(() => ({
  transactions: [] as Array<Record<string, unknown>>,
  budgets: [] as Array<Record<string, unknown>>,
}));
const decimal = (n: number) => ({ toNumber: () => n, valueOf: () => n });
const out = (r: Record<string, unknown>) => ({ ...r, amount: decimal(r.amount as number), date: new Date(`${r.date}T00:00:00.000Z`), account: r.accountType ? { type: r.accountType } : null });

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    transaction: {
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => store.transactions.filter((r) => matchesWhere(r as Row, args.where)).map(out)),
    },
    transactionShare: { findMany: vi.fn(async () => []) },
    account: { findMany: vi.fn(async () => [{ id: 'card' }]) },
    budget: { findMany: vi.fn(async () => store.budgets.map((b) => ({ ...b, monthlyLimit: decimal(b.monthlyLimit as number) }))) },
    recurringTransaction: { findMany: vi.fn(async () => []) },
    category: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
  },
}));

const { getDashboardOverview } = await import('./dashboard.service.js');
const { getBudgetSummary } = await import('../budgets/budgets.service.js');

let seq = 0;
function tx(over: Record<string, unknown>) {
  seq += 1;
  store.transactions.push({ id: `t-${seq}`, householdId: HH, type: 'EXPENSE', categoryName: 'GROCERIES', amount: -10, date: '2026-10-05', competenceMonth: null, attachmentUrl: null, accountId: 'bank', accountType: 'CHECKING', ...over });
}
const card = (over: Record<string, unknown>) => tx({ accountId: 'card', accountType: 'CREDIT', ...over });
const MONTH = new Date(Date.UTC(2026, 9, 1));

beforeEach(() => {
  store.transactions.length = 0;
  store.budgets.length = 0;
  seq = 0;
});

describe('dashboard overview: accrual, like the budgets', () => {
  it('counts card purchases in their month and leaves out the invoice payment', async () => {
    tx({ amount: -100 }); // debit
    card({ amount: -250.5 }); // card purchase
    card({ amount: -40, categoryName: 'FOOD', date: '2026-10-20' });
    tx({ amount: -5000, categoryName: 'OTHER_EXPENSES', attachmentUrl: 'invoice_pay:card:2026-10' }); // payment of the invoice
    const o = await getDashboardOverview({ householdId: HH, month: '2026-10' });
    expect(o.summary.totalExpense).toBe(390.5);
    expect(o.categoryBreakdown.find((c) => c.name === 'GROCERIES')?.expense).toBe(350.5);
    expect(o.categoryBreakdown.find((c) => c.name === 'OTHER_EXPENSES')).toBeUndefined();
    expect(o.monthlyComparison[5]!.expense).toBe(390.5);
    expect(o.fixedVsVariable.variable).toBe(390.5);
  });

  it('shows the same figures as the budget summary for the same data', async () => {
    store.budgets.push({ id: 'b1', householdId: HH, categoryName: 'GROCERIES', monthlyLimit: 500, month: MONTH, type: 'EXPENSE' });
    store.budgets.push({ id: 'b2', householdId: HH, categoryName: GENERAL_BUDGET_CATEGORY, monthlyLimit: 2000, month: MONTH, type: 'EXPENSE' });
    tx({ amount: -100 });
    card({ amount: -250.5 });
    card({ amount: -40, categoryName: 'FOOD', competenceMonth: '2026-10', date: '2026-09-28' });
    card({ amount: -999, date: '2026-11-02' }); // next month: not here
    tx({ amount: -5000, categoryName: 'OTHER_EXPENSES', attachmentUrl: 'invoice_pay:card:2026-10' });
    const o = await getDashboardOverview({ householdId: HH, month: '2026-10' });
    const s = (await getBudgetSummary({ householdId: HH, month: '2026-10' } as never)) as { budgets: Array<{ categoryName: string; spending: number }> };
    for (const b of s.budgets) {
      expect(o.budgetVsRealized.find((r) => r.category === b.categoryName)?.spent).toBe(b.spending);
    }
    expect(o.summary.totalExpense).toBe(s.budgets.find((b) => b.categoryName === GENERAL_BUDGET_CATEGORY)!.spending);
  });
});
