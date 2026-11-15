import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesWhere, type Row } from '../../shared/__fixtures__/where-eval.js';

// A refund (INCOME row with isRefund) cancels an expense: it is never income. The dashboard, the budget summary and
// the budget alerts read it through the same rule (budget-spending.ts), and a category may go negative in a month.
const HH = 'hh-1';
const store = vi.hoisted(() => ({
  transactions: [] as Array<Record<string, unknown>>,
  budgets: [] as Array<Record<string, unknown>>,
}));

const decimal = (n: number) => ({ toNumber: () => n });
const out = (r: Record<string, unknown>) => ({ ...r, amount: decimal(r.amount as number), date: new Date(`${r.date}T00:00:00.000Z`), account: r.accountType ? { type: r.accountType } : null });

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    transaction: {
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }) =>
        store.transactions.filter((r) => matchesWhere(r as Row, args.where)).map(out)),
    },
    transactionShare: { findMany: vi.fn(async () => []) },
    account: { findMany: vi.fn(async () => []) },
    budget: {
      findMany: vi.fn(async () => store.budgets.map((b) => ({ ...b, monthlyLimit: decimal(b.monthlyLimit as number) }))),
      findFirst: vi.fn(async (args: { where: { month: { lte: Date }; categoryName: string } }) => {
        const wanted = args.where.month.lte.toISOString().slice(0, 7);
        const b = store.budgets.find((x) => x.monthKey === wanted && x.categoryName === args.where.categoryName);
        return b ? { ...b, monthlyLimit: decimal(b.monthlyLimit as number) } : null;
      }),
    },
    recurringTransaction: { findMany: vi.fn(async () => []) },
    category: { findMany: vi.fn(async () => []) },
    householdMember: { findMany: vi.fn(async () => [{ userId: 'u-1', user: { id: 'u-1' } }]) },
    notification: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
  },
}));
vi.mock('../notifications/notifications.service.js', () => ({ createNotification: vi.fn(async () => undefined) }));

const { getDashboardOverview } = await import('./dashboard.service.js');
const { getBudgetSummary } = await import('../budgets/budgets.service.js');
const { checkBudgetThresholds } = await import('../notifications/budget-notifications.service.js');
const { createNotification } = await import('../notifications/notifications.service.js');

let seq = 0;
function tx(over: Record<string, unknown>) {
  seq += 1;
  store.transactions.push({ id: `t-${seq}`, householdId: HH, type: 'EXPENSE', categoryName: 'GROCERIES', amount: -10, competenceMonth: null, isRefund: false, attachmentUrl: null, accountId: 'acc', accountType: 'CHECKING', ...over });
}
const refund = (over: Record<string, unknown>) => tx({ type: 'INCOME', isRefund: true, categoryName: 'GROCERIES', ...over });
const OCT = new Date(Date.UTC(2026, 9, 1));
const budget = (over: Record<string, unknown> = {}) =>
  store.budgets.push({ id: 'b1', householdId: HH, categoryName: 'GROCERIES', monthlyLimit: 100, monthKey: '2026-10', month: OCT, type: 'EXPENSE', ...over });

beforeEach(() => {
  store.transactions.length = 0;
  store.budgets.length = 0;
  seq = 0;
  vi.clearAllMocks();
});

describe('dashboard: a refund cancels the expense', () => {
  it('purchase of 100 and refund of 30 in the same month: expense 70, income 0, in every figure of the overview', async () => {
    budget();
    tx({ date: '2026-10-05', amount: -100 });
    refund({ date: '2026-10-12', amount: 30 });
    const o = await getDashboardOverview({ householdId: HH, month: '2026-10' });
    expect(o.summary).toEqual({ totalIncome: 0, totalExpense: 70, balance: -70 });
    const cat = o.categoryBreakdown.find((c) => c.name === 'GROCERIES')!;
    expect([cat.income, cat.expense, cat.ownExpense]).toEqual([0, 70, 70]);
    expect(o.budgetVsRealized.find((b) => b.category === 'GROCERIES')!.spent).toBe(70);
    expect(o.monthlyComparison[5]).toMatchObject({ income: 0, expense: 70 });
    expect(o.balanceEvolution[11]!.balance).toBe(-70);
    expect(o.heatmap.total).toBe(70);
    expect(o.heatmap.data[4]!.amount).toBe(100);
    expect(o.heatmap.data[11]!.amount).toBe(-30);
  });

  it('refund in another month than the purchase: the refund month is negative, the purchase month keeps its 100', async () => {
    tx({ date: '2026-09-20', amount: -100 });
    refund({ date: '2026-10-03', amount: 30 });
    const oct = await getDashboardOverview({ householdId: HH, month: '2026-10' });
    expect(oct.summary).toEqual({ totalIncome: 0, totalExpense: -30, balance: 30 });
    expect(oct.categoryBreakdown.find((c) => c.name === 'GROCERIES')!.expense).toBe(-30);
    const sep = await getDashboardOverview({ householdId: HH, month: '2026-09' });
    expect(sep.summary.totalExpense).toBe(100);
    expect(sep.summary.totalIncome).toBe(0);
  });

  it('the same on a card account and on a checking account', async () => {
    tx({ date: '2026-10-05', amount: -100, accountId: 'card', accountType: 'CREDIT' });
    refund({ date: '2026-10-06', amount: 30, accountId: 'card', accountType: 'CREDIT' });
    tx({ date: '2026-10-07', amount: -50, categoryName: 'FOOD' });
    refund({ date: '2026-10-08', amount: 20, categoryName: 'FOOD' });
    const o = await getDashboardOverview({ householdId: HH, month: '2026-10' });
    expect(o.summary).toEqual({ totalIncome: 0, totalExpense: 100, balance: -100 });
    expect(o.categoryBreakdown.find((c) => c.name === 'FOOD')!.expense).toBe(30);
  });

  it('what is not marked stays income: salary, a card "Pagamento recebido" and an unmarked income', async () => {
    tx({ date: '2026-10-05', type: 'INCOME', amount: 1000, categoryName: 'SALARY' });
    tx({ date: '2026-10-06', type: 'INCOME', amount: 300, categoryName: 'OTHER_INCOME', accountType: 'CREDIT', sourceRef: 'ofx:abc:12345678' });
    tx({ date: '2026-10-07', type: 'INCOME', amount: 40, categoryName: 'GROCERIES' });
    tx({ date: '2026-10-08', amount: -100 });
    const o = await getDashboardOverview({ householdId: HH, month: '2026-10' });
    expect(o.summary).toEqual({ totalIncome: 1340, totalExpense: 100, balance: 1240 });
  });

  it('the refund follows the reference month like any other row', async () => {
    tx({ date: '2026-10-05', amount: -100 });
    refund({ date: '2026-09-29', competenceMonth: '2026-10', amount: 30 });
    const o = await getDashboardOverview({ householdId: HH, month: '2026-10' });
    expect(o.summary.totalExpense).toBe(70);
  });
});

describe('budgets: a refund lowers the spending of its category', () => {
  it('summary: 100 spent and 30 refunded is 70 spent', async () => {
    budget();
    tx({ date: '2026-10-05', amount: -100 });
    refund({ date: '2026-10-12', amount: 30 });
    const r = await getBudgetSummary({ householdId: HH, month: '2026-10' } as never);
    expect(r.budgets[0]!.spending).toBe(70);
    expect(r.budgets[0]!.remaining).toBe(30);
  });

  it('the spending of a category may be negative in the month (refund of a purchase of another month)', async () => {
    budget();
    refund({ date: '2026-10-12', amount: 30 });
    const r = await getBudgetSummary({ householdId: HH, month: '2026-10' } as never);
    expect(r.budgets[0]!.spending).toBe(-30);
    expect(r.budgets[0]!.remaining).toBe(130);
  });

  it('the General budget takes the refunds of every category; an income budget never takes a refund', async () => {
    budget({ id: 'g', categoryName: 'GENERAL', monthlyLimit: 500 });
    budget({ id: 'i', categoryName: 'SALARY', monthlyLimit: 1000, type: 'INCOME' });
    tx({ date: '2026-10-05', amount: -100 });
    tx({ date: '2026-10-06', amount: -60, categoryName: 'FOOD' });
    refund({ date: '2026-10-07', amount: 30, categoryName: 'FOOD' });
    tx({ date: '2026-10-08', type: 'INCOME', amount: 700, categoryName: 'SALARY' });
    refund({ date: '2026-10-09', amount: 5, categoryName: 'SALARY' });
    const r = await getBudgetSummary({ householdId: HH, month: '2026-10' } as never);
    const by = (id: string) => r.budgets.find((b) => b.budgetId === id)!;
    expect(by('g').spending).toBe(125); // 100 + 60 - 30 - 5: the refund filed under SALARY cancels an expense too
    expect(by('i').spending).toBe(700);
  });

  it('the alert counts the refund like the screen: 100 minus 30 against a limit of 100 is 70 %, no notice', async () => {
    budget();
    tx({ date: '2026-10-05', amount: -100 });
    refund({ date: '2026-10-12', amount: 30 });
    await checkBudgetThresholds(HH, 'GROCERIES', new Date(2026, 9, 5), 100, 'EXPENSE');
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('without the refund the same purchase does raise the alert (the test above is not vacuous)', async () => {
    budget();
    tx({ date: '2026-10-05', amount: -100 });
    await checkBudgetThresholds(HH, 'GROCERIES', new Date(2026, 9, 5), 100, 'EXPENSE');
    expect(createNotification).toHaveBeenCalledTimes(1);
  });
});
