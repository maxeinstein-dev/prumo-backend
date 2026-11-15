import { beforeEach, describe, expect, it, vi } from 'vitest';

// The monthly flows of the net worth (savings rate): a refund is not income, it takes its amount off the expense.
const store = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
const dec = (n: number) => ({ toNumber: () => n });

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    account: { findMany: vi.fn(async () => []) },
    accountValuation: { findMany: vi.fn(async () => []) },
    employment: { findMany: vi.fn(async () => []) },
    transaction: {
      findMany: vi.fn(async () =>
        store.rows.map((r) => ({
          fromAccountId: null, toAccountId: null, attachmentUrl: null, notes: null, categoryName: 'FOOD', accountId: 'a', isRefund: false, ...r,
          amount: dec(r.amount as number), date: new Date(`${r.date}T00:00:00.000Z`),
        }))),
    },
  },
}));

const { loadNetWorth } = await import('./net-worth.loader.js');

const row = (over: Record<string, unknown>) => store.rows.push({ type: 'EXPENSE', amount: 100, date: '2026-10-05', ...over });
const october = async () => {
  const r = await loadNetWorth({ householdId: 'hh', months: 1, today: new Date(Date.UTC(2026, 9, 20)) });
  return r.months[0]!.savings;
};

beforeEach(() => { store.rows = []; });

describe('net worth flows and refunds', () => {
  it('salary 1000, purchase 100, refund 100: income 1000, expense 0, surplus 1000 (the rate does not rise)', async () => {
    row({ type: 'INCOME', amount: 1000, categoryName: 'SALARY' });
    row({ amount: 100 });
    row({ type: 'INCOME', amount: 100, isRefund: true });
    const s = await october();
    expect([s.income, s.expense, s.surplus]).toEqual([1000, 0, 1000]);
    expect(s.rate).toBe(1);
  });

  it('an unmarked income stays income', async () => {
    row({ type: 'INCOME', amount: 100 });
    const s = await october();
    expect([s.income, s.expense]).toEqual([100, 0]);
  });
});
