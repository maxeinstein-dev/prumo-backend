import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * P24: the aporte (a transfer from a non-investment account to an investment account) counts as spending of its category
 * and of the General budget, leaves the income in "Para onde vai a renda" and moves the balances exactly like any other
 * transfer. A redemption, a transfer between two investment accounts, a transfer between banks and a buy of quotes inside
 * the investment account do not count. Against a real PostgreSQL, because the rule is a relation filter (the type of the
 * destination and source accounts) and only the database proves what Prisma does with it. Invented data only.
 *
 * Opt-in: set TEST_DATABASE_ADMIN_URL to a throwaway server (any database of it). The test creates its own scratch
 * database, applies the migrations, runs the scenarios and drops it. Never point it at a server that holds real data.
 */
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (process.env.CI && !adminUrl) throw new Error('TEST_DATABASE_ADMIN_URL is required in CI (see .github/workflows/ci.yml)');

vi.mock('../../shared/db/prisma.js', async () => {
  const { PrismaClient } = await import('../../generated/prisma/client.js');
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  return { prisma: new PrismaClient({ adapter: new PrismaPg(pool) }), testPool: pool };
});

describe.skipIf(!adminUrl)('aporte counts as invested (P24), on a real database', () => {
  const scratch = `recta_test_aporte_${Date.now()}`;
  const admin = new pg.Client({ connectionString: adminUrl });

  let prisma: typeof import('../../shared/db/prisma.js').prisma;
  let pool: pg.Pool;
  let tx: typeof import('../transactions/transactions.service.js');
  let budgets: typeof import('./budgets.service.js');
  let dash: typeof import('../dashboard/dashboard.service.js');
  let split: typeof import('../dashboard/income-split.loader.js');
  let byMethod: typeof import('../dashboard/spending-by-method.loader.js');
  let simulation: typeof import('../dashboard/purchase-simulation.loader.js');

  let householdId: string;
  let bank: string;
  let bank2: string;
  let broker: string;
  let broker2: string;
  let investCategory: string;
  const MONTH = '2026-12';
  const DAY = new Date(Date.UTC(2026, 11, 5));
  const TODAY = new Date(Date.UTC(2026, 11, 10));

  async function snapshot() {
    const summary = (await budgets.getBudgetSummary({ householdId, month: MONTH } as never)) as {
      budgets: Array<{ categoryName: string; spending: number; ownSpent: number }>;
    };
    const budgetOf = (name: string) => summary.budgets.find((b) => b.categoryName === name)!;
    const overview = await dash.getDashboardOverview({ householdId, month: MONTH });
    const bvrOf = (name: string) => overview.budgetVsRealized.find((b) => b.category === name)!;
    const incomeSplit = await split.loadIncomeSplit({ householdId, month: MONTH, today: TODAY });
    const method = await byMethod.loadSpendingByMethod({ householdId, months: 1, to: MONTH });
    const sim = await simulation.loadPurchaseSimulation({ householdId, totalAmount: 10, installments: 1, today: TODAY });
    const accounts = await prisma.account.findMany({ where: { householdId }, select: { id: true, balance: true, totalBalance: true, availableBalance: true } });
    const balances = Object.fromEntries(accounts.map((a) => [a.id, [a.balance.toNumber(), a.totalBalance.toNumber(), a.availableBalance.toNumber()]]));
    return {
      invested: { spending: budgetOf(investCategory).spending, ownSpent: budgetOf(investCategory).ownSpent },
      general: { spending: budgetOf('GENERAL').spending, ownSpent: budgetOf('GENERAL').ownSpent },
      dashboard: { invested: bvrOf(investCategory).spent, general: bvrOf('GENERAL').spent, generalOwn: bvrOf('GENERAL').ownSpent, totalExpense: overview.summary.totalExpense },
      split: { leftover: incomeSplit.leftover.amount, totalSpent: incomeSplit.totalSpent, invested: incomeSplit.invested.amount },
      method: method.totals.total,
      simulationPosted: sim.months.find((m) => m.month === MONTH)!.committedPosted,
      balances,
    };
  }

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${scratch}"`);
    const scratchUrl = new URL(adminUrl!);
    scratchUrl.pathname = `/${scratch}`;
    execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env, DATABASE_URL: scratchUrl.toString() } });
    process.env.DATABASE_URL = scratchUrl.toString();
    const db = (await import('../../shared/db/prisma.js')) as unknown as { prisma: typeof prisma; testPool: pg.Pool };
    prisma = db.prisma;
    pool = db.testPool;
    tx = await import('../transactions/transactions.service.js');
    budgets = await import('./budgets.service.js');
    dash = await import('../dashboard/dashboard.service.js');
    split = await import('../dashboard/income-split.loader.js');
    byMethod = await import('../dashboard/spending-by-method.loader.js');
    simulation = await import('../dashboard/purchase-simulation.loader.js');

    householdId = (await prisma.household.create({ data: { name: 'Casa Teste' } })).id;
    const user = await prisma.user.create({ data: { email: 'pessoa.teste@example.test' } });
    await prisma.householdMember.create({ data: { householdId, userId: user.id, role: 'OWNER' } });
    const account = (name: string, type: 'CHECKING' | 'INVESTMENT') =>
      prisma.account.create({ data: { householdId, name, type, balance: 5000, totalBalance: 5000, availableBalance: 5000 } }).then((a) => a.id);
    bank = await account('Banco Teste', 'CHECKING');
    bank2 = await account('Banco Dois', 'CHECKING');
    broker = await account('Corretora Teste', 'INVESTMENT');
    broker2 = await account('Corretora Dois', 'INVESTMENT');
    const category = await prisma.category.create({ data: { householdId, name: 'Investimentos', type: 'EXPENSE' } });
    investCategory = `CUSTOM:${category.id}`;
    const month = new Date(Date.UTC(2026, 11, 1));
    await prisma.budget.create({ data: { householdId, categoryName: investCategory, monthlyLimit: 290, month, type: 'EXPENSE', measure: 'OWN_SHARE' } });
    await prisma.budget.create({ data: { householdId, categoryName: 'GENERAL', monthlyLimit: 3000, month, type: 'EXPENSE', measure: 'OWN_SHARE' } });
    // An ordinary expense, so the General budget has something before the aporte
    await prisma.transaction.create({ data: { householdId, accountId: bank, type: 'EXPENSE', categoryName: 'GROCERIES', amount: -100, date: DAY, paid: true } });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${scratch}"`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  it('1. an aporte of 250 to the broker, filed under Investimentos: 250 of 290, General +250, Livre da renda -250; balances as a transfer', async () => {
    const before = await snapshot();
    expect(before.invested).toEqual({ spending: 0, ownSpent: 0 });
    expect(before.general.spending).toBe(100);

    const created = await tx.createTransfer({ householdId, fromAccountId: bank, toAccountId: broker, amount: 250, date: DAY, categoryName: investCategory });
    expect(created.categoryName).toBe(investCategory);

    const after = await snapshot();
    expect(after.invested).toEqual({ spending: 250, ownSpent: 250 });
    expect(after.general).toEqual({ spending: 350, ownSpent: 350 });
    expect(after.dashboard.invested).toBe(250);
    expect(after.dashboard.general).toBe(350);
    expect(after.dashboard.generalOwn).toBe(350);
    expect(after.split.leftover).toBe(before.split.leftover - 250);
    expect(after.split.totalSpent).toBe(before.split.totalSpent + 250);
    expect(after.split.invested).toBe(250);
    expect(after.simulationPosted).toBe(before.simulationPosted + 250);
    // Not a purchase: the credit x debit numbers and the dashboard's income/expense summary stay the same
    expect(after.method).toBe(before.method);
    expect(after.dashboard.totalExpense).toBe(before.dashboard.totalExpense);
    // 5. The money moves once, like any transfer: out of the bank, into the broker, nothing else
    expect(after.balances[bank]![2]).toBe(before.balances[bank]![2] - 250);
    expect(after.balances[broker]![2]).toBe(before.balances[broker]![2] + 250);
    expect(after.balances[bank]![1]).toBe(before.balances[bank]![1]);
    expect(after.balances[bank2]).toEqual(before.balances[bank2]);

    // The budget alert sees the same 250 (it crossed 80% of 290)
    const alerts = await prisma.notification.findMany({});
    expect(alerts.map((n) => (n.metadata as { spending?: number }).spending)).toContain(250);
  });

  it('2 and 3. a redemption, a transfer between two brokers and one between banks change no budget, even with the category', async () => {
    const before = await snapshot();
    await tx.createTransfer({ householdId, fromAccountId: broker, toAccountId: bank, amount: 50, date: DAY, categoryName: investCategory });
    await tx.createTransfer({ householdId, fromAccountId: broker, toAccountId: broker2, amount: 70, date: DAY, categoryName: investCategory });
    await tx.createTransfer({ householdId, fromAccountId: bank, toAccountId: bank2, amount: 80, date: DAY, categoryName: investCategory });
    await tx.createTransfer({ householdId, fromAccountId: bank, toAccountId: bank2, amount: 90, date: DAY });
    const after = await snapshot();
    expect(after.invested).toEqual(before.invested);
    expect(after.general).toEqual(before.general);
    expect(after.dashboard).toEqual(before.dashboard);
    expect(after.split).toEqual(before.split);
    expect(after.simulationPosted).toBe(before.simulationPosted);
  });

  it('4. a buy of quotes inside the broker (reinvestment) changes nothing', async () => {
    const before = await snapshot();
    const position = await prisma.investmentPosition.create({ data: { householdId, accountId: broker, kind: 'STOCK_EXCHANGE', ticker: 'TST11', name: 'Fundo Teste' } });
    await prisma.investmentMovement.create({ data: { householdId, positionId: position.id, date: DAY, type: 'BUY', quantity: 2, unitPrice: 100, amount: 200 } });
    const after = await snapshot();
    expect(after).toEqual(before);
  });

  it('an aporte without a category counts in the General budget only (open point 1)', async () => {
    const before = await snapshot();
    const created = await tx.createTransfer({ householdId, fromAccountId: bank, toAccountId: broker, amount: 20, date: DAY });
    expect(created.categoryName).toBe('TRANSFER');
    const after = await snapshot();
    expect(after.invested).toEqual(before.invested);
    expect(after.general.spending).toBe(before.general.spending + 20);
    expect(after.split.leftover).toBe(before.split.leftover - 20);
    expect(after.split.invested).toBe(before.split.invested + 20);
  });

  it('the category of a transfer must be a category of the household', async () => {
    await expect(
      tx.createTransfer({ householdId, fromAccountId: bank, toAccountId: broker, amount: 10, date: DAY, categoryName: 'CUSTOM:00000000-0000-4000-8000-000000000000' }),
    ).rejects.toThrow(/Custom category not found/);
  });
});
