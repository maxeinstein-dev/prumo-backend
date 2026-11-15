import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesWhere, type Row } from '../../shared/__fixtures__/where-eval.js';

// Monthly comparison (6 months), balance evolution (12 months) and the heatmap of the dashboard overview.
// The aggregates are locked by figures; the heatmap follows the same month rule as the totals (reference month).
const HH = 'hh-1';
const store = vi.hoisted(() => ({ transactions: [] as Array<Record<string, unknown>>, findManyCalls: 0 }));

const decimal = (n: number) => ({ toNumber: () => n });
const out = (r: Record<string, unknown>) => ({ ...r, amount: decimal(r.amount as number), date: new Date(`${r.date}T00:00:00.000Z`), account: r.accountType ? { type: r.accountType } : null });

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    transaction: {
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => {
        store.findManyCalls += 1;
        return store.transactions.filter((r) => matchesWhere(r as Row, args.where)).map(out);
      }),
    },
    transactionShare: { findMany: vi.fn(async () => []) },
    account: { findMany: vi.fn(async () => []) },
    budget: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    recurringTransaction: { findMany: vi.fn(async () => []) },
    category: { findMany: vi.fn(async () => []) },
    householdMember: { findMany: vi.fn(async () => []) },
    // Used to be the heatmap query. It must not be needed any more: if it is called it returns nothing.
    $queryRaw: vi.fn(async () => []),
  },
}));

const { getDashboardOverview } = await import('./dashboard.service.js');

let seq = 0;
function tx(over: Record<string, unknown>) {
  seq += 1;
  store.transactions.push({ id: `t-${seq}`, householdId: HH, type: 'EXPENSE', categoryName: 'GROCERIES', amount: -10, competenceMonth: null, attachmentUrl: null, accountId: 'acc', accountType: 'CHECKING', ...over });
}

beforeEach(() => {
  store.transactions.length = 0;
  store.findManyCalls = 0;
  seq = 0;
  vi.clearAllMocks();
});

function seedYear() {
  tx({ date: '2025-11-10', type: 'INCOME', amount: 100, categoryName: 'SALARY' }); // first of the 12 months
  tx({ date: '2025-11-12', amount: -40 });
  tx({ date: '2026-02-03', type: 'INCOME', amount: 250.5, categoryName: 'SALARY' });
  tx({ date: '2026-02-20', amount: -80.25 });
  tx({ date: '2026-05-15', amount: -30 });
  tx({ date: '2026-05-16', type: 'TRANSFER', amount: -999, categoryName: 'TRANSFER' }); // ignored
  tx({ date: '2026-05-17', type: 'ALLOCATION', amount: -888, categoryName: 'SAVINGS' }); // ignored
  tx({ date: '2026-05-18', amount: -500, attachmentUrl: 'invoice_pay:abc' }); // invoice payment: ignored
  tx({ date: '2026-05-19', amount: -77, attachmentUrl: 'invoiceXpay:abc' }); // not an invoice payment: counts
  tx({ date: '2026-06-01', type: 'INCOME', amount: 1000, categoryName: 'SALARY' });
  tx({ date: '2026-06-29', competenceMonth: '2026-07', amount: -60 }); // belongs to July
  tx({ date: '2026-07-05', amount: -15 });
  tx({ date: '2026-10-05', type: 'INCOME', amount: 2000, categoryName: 'SALARY' });
  tx({ date: '2026-10-31', amount: -300 });
  tx({ date: '2026-09-29', competenceMonth: '2026-10', type: 'INCOME', amount: 600, categoryName: 'OTHER_INCOME' });
  tx({ date: '2024-10-01', amount: -5000 }); // outside the 12 months
  tx({ date: '2026-11-01', amount: -9000 }); // after the month
}

describe('monthly comparison and balance evolution (locked figures)', () => {
  it('6 months for the comparison, 12 for the balance, by reference month, without transfers or invoice payments', async () => {
    seedYear();
    const o = await getDashboardOverview({ householdId: HH, month: '2026-10' });
    expect(o.monthlyComparison).toHaveLength(6);
    expect(o.balanceEvolution).toHaveLength(12);
    // May, Jun, Jul, Aug, Sep, Oct
    expect(o.monthlyComparison.map((m) => [m.income, m.expense])).toEqual([[0, 107], [1000, 0], [0, 75], [0, 0], [0, 0], [2600, 300]]);
    // running balance over the 12 months Nov/25 .. Oct/26
    expect(o.balanceEvolution.map((b) => b.balance)).toEqual([60, 60, 60, 230.25, 230.25, 230.25, 123.25, 1123.25, 1048.25, 1048.25, 1048.25, 3348.25]);
  });

  it('months with no rows are zeros and the window crosses the year boundary', async () => {
    tx({ date: '2026-01-10', type: 'INCOME', amount: 10, categoryName: 'SALARY' });
    const o = await getDashboardOverview({ householdId: HH, month: '2026-02' });
    expect(o.monthlyComparison.map((m) => m.income)).toEqual([0, 0, 0, 0, 10, 0]);
    expect(o.balanceEvolution.map((b) => b.balance)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 10]);
  });

  it('reads the rows once for both windows, not once per month', async () => {
    seedYear();
    await getDashboardOverview({ householdId: HH, month: '2026-10' });
    // current month + previous month + one read of the 12 months; it used to be 2 + 18
    expect(store.findManyCalls).toBeLessThanOrEqual(3);
  });
});

describe('heatmap follows the reference month', () => {
  it('a purchase dated in September with reference month October counts in the October heatmap, on its calendar day', async () => {
    tx({ date: '2026-09-15', competenceMonth: '2026-10', amount: -120 });
    tx({ date: '2026-10-05', amount: -30.5 });
    const o = await getDashboardOverview({ householdId: HH, month: '2026-10' });
    expect(o.heatmap.total).toBe(150.5);
    expect(o.heatmap.total).toBe(o.summary.totalExpense);
    expect(o.heatmap.data.find((d) => d.day === 15)!.amount).toBe(120);
    expect(o.heatmap.data.find((d) => d.day === 5)!.amount).toBe(30.5);
    const sep = await getDashboardOverview({ householdId: HH, month: '2026-09' });
    expect(sep.heatmap.total).toBe(0);
  });

  it('a day that does not exist in the reference month goes to its last day (the total never loses money)', async () => {
    tx({ date: '2026-10-31', competenceMonth: '2026-11', amount: -50 }); // November has 30 days
    const o = await getDashboardOverview({ householdId: HH, month: '2026-11' });
    expect(o.heatmap.daysInMonth).toBe(30);
    expect(o.heatmap.data).toHaveLength(30);
    expect(o.heatmap.data[29]!.amount).toBe(50);
    expect(o.heatmap.total).toBe(50);
  });

  it('without reference months it is the calendar of the date, summing the same day', async () => {
    tx({ date: '2026-10-05', amount: -10.1 });
    tx({ date: '2026-10-05', amount: -20.2 });
    tx({ date: '2026-10-31', amount: -3 });
    tx({ date: '2026-09-30', amount: -99 });
    tx({ date: '2026-11-01', amount: -99 });
    const o = await getDashboardOverview({ householdId: HH, month: '2026-10' });
    expect(o.heatmap.data).toHaveLength(31);
    expect(o.heatmap.data[4]!.amount).toBe(30.3);
    expect(o.heatmap.data[30]!.amount).toBe(3);
    expect(o.heatmap.total).toBe(33.3);
  });

  it('income, transfers and invoice payments stay out of the heatmap', async () => {
    tx({ date: '2026-10-05', type: 'INCOME', amount: 500, categoryName: 'SALARY' });
    tx({ date: '2026-10-06', type: 'TRANSFER', amount: -70, categoryName: 'TRANSFER' });
    tx({ date: '2026-10-07', amount: -200, attachmentUrl: 'invoice_pay:xyz' });
    tx({ date: '2026-10-08', amount: -9, attachmentUrl: 'invoiceXpay:xyz' });
    const o = await getDashboardOverview({ householdId: HH, month: '2026-10' });
    expect(o.heatmap.total).toBe(9);
  });
});
