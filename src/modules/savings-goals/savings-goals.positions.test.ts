import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P21 L4: a goal with investment positions linked takes its value from them. Invented data only.
const db = vi.hoisted(() => {
  const d: Record<string, any> = {
    $queryRaw: vi.fn(),
    savingsGoal: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    savingsGoalContribution: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() },
    account: { findFirst: vi.fn(), findMany: vi.fn() },
    investmentPosition: { findMany: vi.fn() },
    investmentMovement: { findMany: vi.fn() },
    assetQuote: { findMany: vi.fn() },
    indexRate: { findMany: vi.fn() },
  };
  d.$transaction = vi.fn(async (fn: (t: unknown) => unknown) => fn(d));
  return d;
});
vi.mock('../../shared/db/prisma.js', () => ({ prisma: db }));

import { contribute, undoContribution } from './savings-goals.contributions.js';
import { addToSavingsGoal, getSavingsGoal, listSavingsGoals, savingsSummary, updateSavingsGoal } from './savings-goals.service.js';

const HH = '00000000-0000-4000-8000-0000000000f0';
const ACC = '00000000-0000-4000-8000-000000000001';
const BRK = '00000000-0000-4000-8000-000000000002';
const G_POS = '00000000-0000-4000-8000-0000000000a1';
const G_MAN = '00000000-0000-4000-8000-0000000000a2';
const P1 = '00000000-0000-4000-8000-000000000010';
const P2 = '00000000-0000-4000-8000-000000000011';
const dec = (n: number) => ({ toNumber: () => n, toString: () => String(n) });
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const TODAY = new Date(Date.UTC(2026, 10, 9));

const goal = (id: string, over: Record<string, unknown> = {}) => ({
  id, householdId: HH, accountId: ACC, name: id === G_POS ? 'Meta Exemplo' : 'Reserva Exemplo', kind: 'RESERVE',
  targetAmount: dec(1000), currentAmount: dec(300), monthlyContribution: dec(100), contributionDay: 10, dueMonth: null,
  targetDate: null, createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'), ...over,
});
const stock = (id: string, goalId: string | null, ticker: string, over: Record<string, unknown> = {}) => ({
  id, householdId: HH, accountId: BRK, savingsGoalId: goalId, kind: 'STOCK_EXCHANGE', ticker, indexer: null, rate: null,
  maturityDate: null, anchorAmount: null, anchorDate: null, closedAt: null, ...over,
});
let n = 0;
const opening = (positionId: string, quantity: number, amount: number) => ({
  id: `00000000-0000-4000-8000-0000000002${String(++n).padStart(2, '0')}`, positionId, type: 'OPENING', date: day('2026-10-01'),
  quantity: dec(quantity), unitPrice: dec(amount / quantity), amount: dec(amount), notes: null, sourceRef: null, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
});

/** Two goals: G_POS (stored 300, positions worth 123,40 + 60,00) and G_MAN (stored 300, no position). */
function setup() {
  db.savingsGoal.findMany.mockResolvedValue([goal(G_POS), goal(G_MAN)]);
  db.savingsGoal.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => [goal(G_POS), goal(G_MAN)].find((g) => g.id === where.id) ?? null);
  db.savingsGoalContribution.findMany.mockResolvedValue([]);
  db.investmentPosition.findMany.mockImplementation(async (args: { where: { savingsGoalId: { in: string[] }; closedAt: null }; select?: unknown }) => {
    const all = [stock(P1, G_POS, 'TEST11'), stock(P2, G_POS, 'ABCD3')];
    const rows = all.filter((p) => args.where.savingsGoalId.in.includes(p.savingsGoalId!));
    return args.select ? rows.map((r) => ({ savingsGoalId: r.savingsGoalId })) : rows;
  });
  db.investmentMovement.findMany.mockResolvedValue([opening(P1, 10, 100), opening(P2, 2, 40)]);
  db.assetQuote.findMany.mockResolvedValue([
    { ticker: 'TEST11', date: day('2026-11-06'), close: dec(12.34) }, // 123,40 (cost 100)
    { ticker: 'ABCD3', date: day('2026-11-05'), close: dec(30) }, // 60,00 (cost 40)
  ]);
  db.indexRate.findMany.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
  db.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(db));
  setup();
});
afterEach(() => vi.useRealTimers());

describe('listSavingsGoals with positions linked', () => {
  it('progress is the sum of the CURRENT value of the open positions, and the rest comes from it', async () => {
    const out = await listSavingsGoals({ householdId: HH, today: TODAY });
    const g = out.find((x) => x.id === G_POS)!;
    expect(g).toMatchObject({
      currentAmount: 183.4, // 123,40 + 60,00, never the cost (140) nor the stored 300
      remaining: 816.6,
      percentage: 18.34,
      isCompleted: false,
      fromPositions: true,
      positionsCount: 2,
      valueDate: '2026-11-05',
      estimated: false,
      noQuote: false,
    });
    expect(g.targetAmount).toBe(1000);
  });

  it('a goal with no position stays exactly as before: the kept amount, and the new fields say so', async () => {
    const out = await listSavingsGoals({ householdId: HH, today: TODAY });
    expect(out.find((x) => x.id === G_MAN)).toMatchObject({
      currentAmount: 300, remaining: 700, percentage: 30, isCompleted: false,
      fromPositions: false, positionsCount: 0, valueDate: null, estimated: false, noQuote: false,
    });
  });

  it('a goal whose only position was closed goes back to its kept amount', async () => {
    db.investmentPosition.findMany.mockResolvedValue([]);
    const out = await listSavingsGoals({ householdId: HH, today: TODAY });
    expect(out.find((x) => x.id === G_POS)).toMatchObject({ currentAmount: 300, fromPositions: false, positionsCount: 0 });
  });

  it('the market can pass the target: progress goes over 100%, nothing is left to reach, the goal is completed', async () => {
    db.assetQuote.findMany.mockResolvedValue([
      { ticker: 'TEST11', date: day('2026-11-06'), close: dec(100) }, // 1000,00
      { ticker: 'ABCD3', date: day('2026-11-05'), close: dec(75) }, // 150,00
    ]);
    const g = (await listSavingsGoals({ householdId: HH, today: TODAY })).find((x) => x.id === G_POS)!;
    expect(g).toMatchObject({ currentAmount: 1150, remaining: 0, percentage: 115, isCompleted: true });
  });

  it('a stock without a quote is worth its cost and the goal says it is an estimate', async () => {
    db.assetQuote.findMany.mockResolvedValue([]);
    const g = (await listSavingsGoals({ householdId: HH, today: TODAY })).find((x) => x.id === G_POS)!;
    expect(g).toMatchObject({ currentAmount: 140, estimated: true, noQuote: true, valueDate: null });
  });

  it('loads everything of all the goals in batch (no query per goal)', async () => {
    await listSavingsGoals({ householdId: HH, today: TODAY });
    expect(db.investmentPosition.findMany).toHaveBeenCalledTimes(1);
    expect(db.investmentMovement.findMany).toHaveBeenCalledTimes(1);
    expect(db.assetQuote.findMany).toHaveBeenCalledTimes(1);
  });

  it('the planned contribution of the month is not offered for a goal that takes no manual contribution', async () => {
    const out = await listSavingsGoals({ householdId: HH, today: TODAY });
    expect(out.find((x) => x.id === G_POS)!.thisMonth).toMatchObject({ status: 'none', plannedAmount: 0 });
    expect(out.find((x) => x.id === G_MAN)!.thisMonth).toMatchObject({ status: 'pending', plannedAmount: 100 });
  });
});

describe('getSavingsGoal', () => {
  it('the detail has the same value and fields as the list', async () => {
    const g = await getSavingsGoal(G_POS);
    expect(g).toMatchObject({ currentAmount: 183.4, remaining: 816.6, fromPositions: true, positionsCount: 2 });
    expect(await getSavingsGoal(G_MAN)).toMatchObject({ currentAmount: 300, fromPositions: false });
  });

  it('asking only for the household (permission check) reads no position', async () => {
    const g = await getSavingsGoal(G_POS, { valued: false });
    expect(g.householdId).toBe(HH);
    expect(db.investmentPosition.findMany).not.toHaveBeenCalled();
  });
});

describe('manual contributions are refused for a goal with positions (the value comes from them)', () => {
  it('addToSavingsGoal: 400 and nothing written', async () => {
    db.savingsGoal.findFirst.mockResolvedValue(goal(G_POS));
    await expect(addToSavingsGoal(G_POS, HH, { amount: 10 })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/positions/) });
    expect(db.savingsGoal.update).not.toHaveBeenCalled();
  });

  it('addToSavingsGoal still works for a goal without positions', async () => {
    db.savingsGoal.findFirst.mockResolvedValue(goal(G_MAN));
    db.savingsGoal.update.mockResolvedValue(goal(G_MAN, { currentAmount: dec(310) }));
    await addToSavingsGoal(G_MAN, HH, { amount: 10 });
    expect(db.savingsGoal.update.mock.calls[0]![0].data.currentAmount.toString()).toBe('310');
  });

  it('contribute ("guardar agora"): 400, no contribution row, no change of the kept amount', async () => {
    db.$queryRaw.mockResolvedValue([{ id: G_POS }]);
    db.savingsGoal.findFirst.mockResolvedValue(goal(G_POS));
    await expect(contribute({ goalId: G_POS, householdId: HH, amount: 50, today: TODAY })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/positions/) });
    expect(db.savingsGoalContribution.create).not.toHaveBeenCalled();
    expect(db.savingsGoal.update).not.toHaveBeenCalled();
  });

  it('contribute still works for a goal without positions', async () => {
    db.$queryRaw.mockResolvedValue([{ id: G_MAN }]);
    db.savingsGoal.findFirst.mockResolvedValue(goal(G_MAN));
    db.savingsGoalContribution.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'c1', ...data }));
    db.savingsGoal.update.mockResolvedValue({ currentAmount: dec(350) });
    const out = await contribute({ goalId: G_MAN, householdId: HH, amount: 50, today: TODAY });
    expect(out.contribution.amount).toBe(50);
  });

  it('undoing an old contribution stays possible (it only keeps the hidden kept amount consistent)', async () => {
    db.$queryRaw.mockResolvedValue([{ id: G_POS }]);
    db.savingsGoal.findFirst.mockResolvedValue(goal(G_POS));
    db.savingsGoalContribution.findFirst.mockResolvedValue({ id: 'c1', goalId: G_POS, amount: dec(100), date: day('2026-10-10'), month: '2026-10', createdAt: new Date() });
    db.savingsGoal.update.mockResolvedValue({});
    const out = await undoContribution({ goalId: G_POS, householdId: HH, contributionId: 'c1' });
    expect(out.goal.currentAmount).toBe(200);
  });

  it('updateSavingsGoal: editing currentAmount is 400, but renaming and lowering the target still work', async () => {
    await expect(updateSavingsGoal(G_POS, { currentAmount: 500 })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/positions/) });
    expect(db.savingsGoal.update).not.toHaveBeenCalled();
    db.savingsGoal.update.mockResolvedValue(goal(G_POS, { name: 'Outra', targetAmount: dec(200) }));
    // the kept amount of 300 is hidden: "current cannot exceed the target" does not apply to a goal worth its positions
    const out = await updateSavingsGoal(G_POS, { name: 'Outra', targetAmount: 200 });
    expect(db.savingsGoal.update).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ fromPositions: true, currentAmount: 183.4, remaining: 16.6 });
  });

  it('updateSavingsGoal: a goal without positions keeps both rules', async () => {
    await expect(updateSavingsGoal(G_MAN, { targetAmount: 200 })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/exceed/) });
    db.savingsGoal.update.mockResolvedValue(goal(G_MAN, { currentAmount: dec(500) }));
    await updateSavingsGoal(G_MAN, { currentAmount: 500 });
    expect(db.savingsGoal.update.mock.calls[0]![0].data.currentAmount.toString()).toBe('500');
  });
});

describe('savingsSummary', () => {
  it('a goal with positions marks nothing inside an account: only the kept amount of the others is allocated', async () => {
    db.savingsGoal.findMany.mockResolvedValue([goal(G_POS), goal(G_MAN)]);
    db.account.findMany.mockResolvedValue([{ id: ACC, name: 'Conta Exemplo', type: 'CHECKING', balance: dec(3000) }]);
    const out = await savingsSummary(HH);
    expect(out.accounts).toEqual([{ accountId: ACC, name: 'Conta Exemplo', type: 'CHECKING', balance: 3000, allocated: 300, free: 2700 }]);
    expect(out.totalAllocated).toBe(300);
  });
});
