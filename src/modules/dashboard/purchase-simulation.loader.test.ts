import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesWhere, type Row } from '../../shared/__fixtures__/where-eval.js';
import { GENERAL_BUDGET_CATEGORY } from '../../shared/enums/index.js';

// The simulator counts like the dashboard and the budgets: by planning month, card purchases in their own month, the
// invoice payment never. Invented data only; the fake database runs the real `where` of each query, and has no
// write methods at all: any attempt to save something throws.
const HH = '11111111-1111-4111-8111-111111111111';
const store = vi.hoisted(() => ({
  transactions: [] as Array<Record<string, unknown>>,
  budgets: [] as Array<Record<string, unknown>>,
  accounts: [] as Array<Record<string, unknown>>,
  recurrences: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  income: new Map<string, number>(),
}));
const decimal = (n: number) => ({ toNumber: () => n, valueOf: () => n });
const out = (r: Record<string, unknown>) => ({ ...r, amount: decimal(r.amount as number), date: new Date(`${r.date}T00:00:00.000Z`), account: r.accountType ? { type: r.accountType } : null });

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    transaction: { findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => store.transactions.filter((r) => matchesWhere(r as Row, args.where)).map(out)) },
    transactionShare: { findMany: vi.fn(async () => []) },
    account: {
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => store.accounts.filter((a) => matchesWhere(a as Row, args.where))),
      findFirst: vi.fn(async (args: { where?: Record<string, unknown> }) => store.accounts.find((a) => matchesWhere(a as Row, args.where)) ?? null),
    },
    budget: { findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => store.budgets.filter((b) => matchesWhere(b as Row, args.where)).map((b) => ({ ...b, monthlyLimit: decimal(b.monthlyLimit as number) }))) },
    recurringTransaction: { findMany: vi.fn(async () => store.recurrences) },
    category: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
  },
}));
vi.mock('../transactions/credit-card-commitment.js', async (orig) => ({
  ...(await orig<object>()),
  expectedIncomeByMonth: vi.fn(async (_hh: string, months: string[]) => new Map(months.map((m) => [m, store.income.get(m) ?? 0]))),
}));
vi.mock('./cash-flow.loader.js', () => ({ recurrenceEvents: vi.fn(async () => store.events) }));

const { loadPurchaseSimulation } = await import('./purchase-simulation.loader.js');
const { getDashboardOverview } = await import('./dashboard.service.js');
const { prisma } = await import('../../shared/db/prisma.js');

let seq = 0;
function tx(over: Record<string, unknown> = {}) {
  seq += 1;
  store.transactions.push({ id: `t-${seq}`, householdId: HH, type: 'EXPENSE', categoryName: 'GROCERIES', amount: -10, date: '2026-11-05', competenceMonth: null, attachmentUrl: null, accountId: 'bank', accountType: 'CHECKING', ...over });
}
const budget = (categoryName: string, monthlyLimit: number, over: Record<string, unknown> = {}) =>
  store.budgets.push({ id: `b-${categoryName}`, householdId: HH, categoryName, monthlyLimit, month: new Date(Date.UTC(2026, 0, 1)), endMonth: null, type: 'EXPENSE', ...over });
const today = new Date(Date.UTC(2026, 10, 15)); // 15/11/2026
const sim = (over: Record<string, unknown> = {}) => loadPurchaseSimulation({ householdId: HH, totalAmount: 1200, installments: 12, today, ...over } as never);
const row = (r: Awaited<ReturnType<typeof sim>>, month: string) => r.months.find((m) => m.month === month)!;

beforeEach(() => {
  vi.clearAllMocks();
  store.transactions.length = 0;
  store.budgets.length = 0;
  store.recurrences.length = 0;
  store.events.length = 0;
  store.income = new Map();
  store.accounts = [
    { id: 'bank', householdId: HH, isActive: true, type: 'CHECKING', closingDay: null, dueDay: null },
    { id: 'card', householdId: HH, isActive: true, type: 'CREDIT', closingDay: 10, dueDay: 17 },
    { id: 'card-no-closing', householdId: HH, isActive: true, type: 'CREDIT', closingDay: null, dueDay: 20 }, // closes on the 13th
    { id: 'alien', householdId: 'other', isActive: true, type: 'CHECKING', closingDay: null, dueDay: null },
  ];
  seq = 0;
});

describe('loadPurchaseSimulation: the months', () => {
  it('starts in the current month and shows every installment month, crossing the year', async () => {
    const r = await sim({ installments: 4, totalAmount: 1200 });
    expect(r.months.map((m) => m.month)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(r.firstMonth).toBe('2026-11');
    expect(r.months.map((m) => m.newInstallment)).toEqual([300, 300, 300, 300]);
  });

  it('shows the months before the first installment too, without a new installment in them', async () => {
    const r = await sim({ installments: 2, firstMonth: '2027-01' });
    expect(r.months.map((m) => [m.month, m.newInstallment])).toEqual([['2026-11', 0], ['2026-12', 0], ['2027-01', 600], ['2027-02', 600]]);
  });

  it('splits in whole cents, the extra cents in the first months, and the sum is the total', async () => {
    const r = await sim({ totalAmount: 100, installments: 3 });
    expect(r.months.map((m) => m.newInstallment)).toEqual([33.34, 33.33, 33.33]);
    expect(r.installments).toEqual([33.34, 33.33, 33.33]);
  });

  it('1x and 24x', async () => {
    const one = await sim({ totalAmount: 99.99, installments: 1 });
    expect(one.months.map((m) => m.newInstallment)).toEqual([99.99]);
    const many = await sim({ totalAmount: 1000.01, installments: 24 });
    expect(many.months).toHaveLength(24);
    expect(many.months.reduce((a, m) => a + Math.round(m.newInstallment * 100), 0)).toBe(100001);
    expect(many.months.at(-1)!.month).toBe('2028-10');
  });

  it('takes the first month from the closing day of the chosen card', async () => {
    expect((await sim({ accountId: 'card' })).firstMonth).toBe('2026-12'); // 15 >= closing day 10
    expect((await sim({ accountId: 'card-no-closing' })).firstMonth).toBe('2026-12'); // 20 - 7 = 13 <= 15
    expect((await sim({ accountId: 'bank' })).firstMonth).toBe('2026-11'); // not a card
    const early = await sim({ accountId: 'card', today: new Date(Date.UTC(2026, 10, 5)) });
    expect(early.firstMonth).toBe('2026-11'); // before the closing day
    expect((await sim({ accountId: 'card', firstMonth: '2027-02' })).firstMonth).toBe('2027-02'); // the user's choice wins
  });

  it('refuses an account of another household, a month in the past and a month too far', async () => {
    await expect(sim({ accountId: 'alien' })).rejects.toThrow();
    await expect(sim({ firstMonth: '2026-10' })).rejects.toThrow();
    await expect(sim({ firstMonth: '2029-01' })).rejects.toThrow();
  });
});

describe('loadPurchaseSimulation: what is already committed', () => {
  it('sums the posted expenses of the month by planning month and the recurrences not generated yet', async () => {
    tx({ amount: -100, date: '2026-12-03' }); // an installment already posted for December
    tx({ amount: -50.5, date: '2026-12-20', accountId: 'card', accountType: 'CREDIT' });
    tx({ amount: -40, date: '2026-11-28', competenceMonth: '2026-12' }); // November date, December in the plan
    tx({ amount: -999, date: '2026-12-05', attachmentUrl: 'invoice_pay:card:2026-11' }); // payment of the invoice: not spending
    tx({ type: 'INCOME', categoryName: 'SALARY', amount: 5000, date: '2026-12-05' }); // income is not committed spending
    store.recurrences.push({ id: 'rec-1', categoryName: 'HOUSING' });
    store.events.push({ date: '2026-12-10', amountCents: -80000, sourceId: 'rec-1' });
    store.events.push({ date: '2026-12-10', amountCents: 300000, sourceId: 'rec-salary' }); // income event: not an expense
    const r = await sim({ installments: 2 });
    const dec = row(r, '2026-12');
    expect(dec.committedPosted).toBe(190.5);
    expect(dec.committedForecast).toBe(800);
    expect(dec.committed).toBe(990.5);
    expect(dec.newInstallment).toBe(600);
    expect(dec.total).toBe(1590.5);
  });

  it('does not count another household', async () => {
    tx({ amount: -100, date: '2026-12-03', householdId: 'other' });
    expect(row(await sim(), '2026-12').committed).toBe(0);
  });

  it('without expected income the leftover is minus the total, and the answer says no income was found', async () => {
    const r = await sim({ installments: 2 });
    expect(row(r, '2026-12').expectedIncome).toBe(0);
    expect(row(r, '2026-12').leftover).toBe(-600);
    expect(r.hasExpectedIncome).toBe(false);
  });

  it('leftover is the expected income minus the committed and the new installment', async () => {
    store.income = new Map([['2026-11', 500000], ['2026-12', 500000]]); // cents
    tx({ amount: -1000, date: '2026-12-03' });
    const r = await sim({ installments: 2 });
    expect(row(r, '2026-12')).toMatchObject({ expectedIncome: 5000, committed: 1000, newInstallment: 600, total: 1600, leftover: 3400, leftoverWithoutPurchase: 4000 });
    expect(r.hasExpectedIncome).toBe(true);
  });
});

describe('loadPurchaseSimulation: tightest month, budgets and the average', () => {
  it('names the tightest month among the ones with an installment, with and without the purchase', async () => {
    store.income = new Map([['2026-11', 500000], ['2026-12', 500000], ['2027-01', 500000]]);
    tx({ amount: -4000, date: '2026-12-03' });
    tx({ amount: -1000, date: '2027-01-03' });
    const r = await sim({ totalAmount: 1000, installments: 2 }); // 500 in Nov and Dec
    expect(r.tightest).toMatchObject({ month: '2026-12', leftover: 500, leftoverWithoutPurchase: 1000 });
  });

  it('a month before the first installment is never the tightest', async () => {
    store.income = new Map([['2026-11', 10000], ['2026-12', 500000]]);
    const r = await sim({ totalAmount: 1000, installments: 1, firstMonth: '2026-12' });
    expect(r.tightest).toMatchObject({ month: '2026-12' });
  });

  it('flags the months where the purchase breaks the general budget and the budget of the category', async () => {
    budget(GENERAL_BUDGET_CATEGORY, 2000);
    budget('ELECTRONICS', 700);
    tx({ amount: -1500, date: '2026-12-03', categoryName: 'GROCERIES' });
    tx({ amount: -300, date: '2026-12-04', categoryName: 'ELECTRONICS' });
    tx({ amount: -100, date: '2027-01-04', categoryName: 'ELECTRONICS' });
    const r = await sim({ totalAmount: 1200, installments: 3, categoryName: 'ELECTRONICS', firstMonth: '2026-12' }); // 400 per month
    // Dec: general 1800 + 400 = 2200 > 2000; category 300 + 400 = 700 = limit (not over).
    // Jan: general 100 + 400 = 500; category 100 + 400 = 500. Feb: nothing posted, 400.
    expect(r.budgetOverruns).toEqual([expect.objectContaining({ month: '2026-12', scope: 'GENERAL', limit: 2000, projected: 2200, withoutPurchase: 1800 })]);
    const r2 = await sim({ totalAmount: 1500, installments: 3, categoryName: 'ELECTRONICS', firstMonth: '2026-12' }); // 500 per month
    expect(r2.budgetOverruns).toEqual([
      expect.objectContaining({ month: '2026-12', scope: 'GENERAL', projected: 2300 }),
      expect.objectContaining({ month: '2026-12', scope: 'CATEGORY', categoryName: 'ELECTRONICS', limit: 700, projected: 800, withoutPurchase: 300 }),
    ]);
  });

  it('only judges the category budget when a category was chosen', async () => {
    budget('ELECTRONICS', 10);
    expect((await sim({ totalAmount: 1200, installments: 2 })).budgetOverruns).toEqual([]);
  });

  it('uses the budget in force in each month (it repeats, and may have ended)', async () => {
    budget(GENERAL_BUDGET_CATEGORY, 500, { endMonth: new Date(Date.UTC(2026, 11, 1)) }); // up to December
    const r = await sim({ totalAmount: 3000, installments: 3 }); // 1000 per month
    expect(r.budgetOverruns.map((o) => o.month)).toEqual(['2026-11', '2026-12']); // January has no budget any more
  });

  it('adds the forecast of the recurrences of the category to the category budget', async () => {
    budget('ELECTRONICS', 700);
    store.recurrences.push({ id: 'rec-1', categoryName: 'ELECTRONICS' });
    store.events.push({ date: '2026-12-10', amountCents: -30000, sourceId: 'rec-1' });
    const r = await sim({ totalAmount: 1000, installments: 2, categoryName: 'ELECTRONICS' }); // 500 per month
    expect(r.budgetOverruns).toEqual([expect.objectContaining({ month: '2026-12', scope: 'CATEGORY', limit: 700, projected: 800, withoutPurchase: 300 })]);
  });

  it('averages the expenses of the 6 months before the current one, by planning month, without invoice payments', async () => {
    for (const [d, v] of [['2026-05-10', 600], ['2026-06-10', 600], ['2026-07-10', 600], ['2026-08-10', 600], ['2026-09-10', 600], ['2026-10-10', 1200]] as const) tx({ amount: -v, date: d });
    tx({ amount: -5000, date: '2026-10-12', attachmentUrl: 'invoice_pay:card:2026-10' });
    tx({ amount: -9999, date: '2026-04-30' }); // before the window
    tx({ amount: -9999, date: '2026-11-02' }); // the current month is not in the average
    const r = await sim();
    expect(r.averageExpense).toEqual({ months: 6, amount: 700 });
  });
});

describe('loadPurchaseSimulation: read only, and the same figures as the dashboard', () => {
  it('only reads: the fake database has no write method, and nothing was stored', async () => {
    tx({ amount: -100, date: '2026-12-03' });
    const before = JSON.stringify(store.transactions);
    await sim();
    expect(JSON.stringify(store.transactions)).toBe(before);
    for (const model of Object.values(prisma as unknown as Record<string, Record<string, unknown>>)) {
      for (const method of ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']) expect(model[method]).toBeUndefined();
    }
  });

  it('shows the same spent figures as the dashboard in the months they have in common', async () => {
    tx({ amount: -100 });
    tx({ amount: -250.5, accountId: 'card', accountType: 'CREDIT', date: '2026-11-12' });
    tx({ amount: -40, categoryName: 'FOOD', date: '2026-10-28', competenceMonth: '2026-11', accountId: 'card', accountType: 'CREDIT' });
    tx({ amount: -5000, categoryName: 'OTHER_EXPENSES', attachmentUrl: 'invoice_pay:card:2026-11' });
    tx({ amount: -75, date: '2026-12-02' });
    tx({ amount: -30, date: '2026-12-03', categoryName: 'FOOD', accountId: 'card', accountType: 'CREDIT' });
    tx({ amount: 3000, type: 'INCOME', categoryName: 'SALARY', date: '2026-11-05' });
    const r = await sim({ installments: 2 });
    for (const month of ['2026-11', '2026-12']) {
      const o = await getDashboardOverview({ householdId: HH, month });
      expect(row(r, month).committedPosted).toBe(o.summary.totalExpense);
      expect(row(r, month).postedByCategory).toEqual(Object.fromEntries(o.categoryBreakdown.filter((c) => c.expense > 0).map((c) => [c.name, c.expense])));
    }
    expect(row(r, '2026-11').committedPosted).toBe(390.5);
  });
});
