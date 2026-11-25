import { beforeEach, describe, expect, it, vi } from 'vitest';

// The mock has NO `transaction` model and NO `account.update`: any code path that tried to create a lançamento or move
// the stored balance would throw. That is the "never count twice" rule (P21 risk 1), pinned in the test double itself.
const db = vi.hoisted(() => {
  const d: Record<string, any> = {
    account: { findUnique: vi.fn() },
    savingsGoal: { findFirst: vi.fn() },
    investmentPosition: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    investmentMovement: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() },
    $queryRaw: vi.fn(),
  };
  d.$transaction = vi.fn(async (cb: (tx: unknown) => unknown) => cb(d));
  return d;
});
vi.mock('../../shared/db/prisma.js', () => ({ prisma: db }));

import {
  createMovement,
  createPosition,
  deleteMovement,
  listPositions,
  loadAccount,
  updatePosition,
} from './investments.service.js';

// Invented data only.
const HH = '00000000-0000-4000-8000-0000000000f0';
const ACC = '00000000-0000-4000-8000-000000000001';
const POS = '00000000-0000-4000-8000-000000000010';
const GOAL = '00000000-0000-4000-8000-000000000020';
const dec = (n: number) => ({ toNumber: () => n, toString: () => String(n) });
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

const account = (over: Record<string, unknown> = {}) => ({
  id: ACC,
  householdId: HH,
  name: 'Corretora Exemplo',
  type: 'INVESTMENT',
  isActive: true,
  balance: dec(1000),
  ...over,
});
const position = (over: Record<string, unknown> = {}) => ({
  id: POS,
  householdId: HH,
  accountId: ACC,
  kind: 'STOCK_EXCHANGE',
  ticker: 'TEST11',
  name: 'Fundo Exemplo',
  savingsGoalId: null,
  indexer: null,
  rate: null,
  maturityDate: null,
  anchorAmount: null,
  anchorDate: null,
  closedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  account: account(),
  ...over,
});
let n = 0;
const movement = (type: string, date: string, quantity: number | null, amount: number, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000001${String(++n).padStart(2, '0')}`,
  householdId: HH,
  positionId: POS,
  type,
  date: day(date),
  quantity: quantity === null ? null : dec(quantity),
  unitPrice: quantity === null ? null : dec(amount / quantity),
  amount: dec(amount),
  notes: null,
  sourceRef: null,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.account.findUnique.mockResolvedValue(account());
  db.investmentPosition.findUnique.mockResolvedValue(position());
  db.investmentPosition.findFirst.mockResolvedValue(null);
  db.investmentPosition.findMany.mockResolvedValue([position()]);
  db.investmentMovement.findMany.mockResolvedValue([]);
  db.investmentMovement.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', createdAt: new Date(), ...data }));
  db.investmentPosition.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => position({ ...data, id: POS }));
  db.$queryRaw.mockResolvedValue([]);
});

describe('account checks', () => {
  it('an unknown account is 404', async () => {
    db.account.findUnique.mockResolvedValue(null);
    await expect(loadAccount(ACC)).rejects.toMatchObject({ statusCode: 404 });
  });
  it('an account that is not an investment account is 400 (list and create)', async () => {
    const checking = account({ type: 'CHECKING' });
    await expect(listPositions(checking as never, {})).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      createPosition(checking as never, { kind: 'STOCK_EXCHANGE', ticker: 'TEST11', name: 'Fundo Exemplo' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(db.investmentPosition.create).not.toHaveBeenCalled();
  });
  it('writing on an inactive account is 400, reading is allowed', async () => {
    const inactive = account({ isActive: false });
    await expect(
      createPosition(inactive as never, { kind: 'STOCK_EXCHANGE', ticker: 'TEST11', name: 'Fundo Exemplo' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(listPositions(inactive as never, {})).resolves.toBeDefined();
  });
});

describe('listPositions: figures and the account summary', () => {
  it('quantity, average price, cost, 12-month income and the cash at the broker', async () => {
    const today = new Date().toISOString().slice(0, 10);
    db.investmentMovement.findMany.mockResolvedValue([
      movement('OPENING', '2026-01-10', 10, 1000),
      movement('BUY', '2026-02-10', 1, 120),
      movement('INCOME', today, null, 9.5),
    ]);
    const res = await listPositions(account({ balance: dec(1000) }) as never, {});
    const p = res.positions[0]!;
    expect(p).toMatchObject({ quantity: 11, avgPrice: 101.818182, costAmount: 1120, incomeLast12Months: 9.5 });
    // 1000,00 in the account - 120,00 bought + 9,50 income; the OPENING takes nothing
    expect(res.summary.accountBalance).toBe(1000);
    expect(res.summary.cashBalance).toBe(889.5);
    expect(res.summary.positionsCost).toBe(1120);
    expect(res.summary.totalAtCost).toBe(2009.5);
  });

  it('closed positions leave the cost but their movements still count in the cash', async () => {
    db.investmentPosition.findMany.mockResolvedValue([position({ closedAt: day('2026-06-01') })]);
    db.investmentMovement.findMany.mockResolvedValue([movement('OPENING', '2026-01-10', 2, 200), movement('SELL', '2026-05-01', 2, 250)]);
    const res = await listPositions(account({ balance: dec(100) }) as never, { includeClosed: true });
    expect(res.summary.cashBalance).toBe(350);
    expect(res.summary.positionsCost).toBe(0);
    expect(res.positions[0]!.closedAt).toBe('2026-06-01');
  });

  it('sums cents, not floats (0.1 + 0.2)', async () => {
    db.investmentMovement.findMany.mockResolvedValue([movement('INCOME', '2026-02-10', null, 0.1), movement('INCOME', '2026-02-11', null, 0.2)]);
    const res = await listPositions(account({ balance: dec(0) }) as never, {});
    expect(res.summary.cashBalance).toBe(0.3);
  });
});

describe('createMovement', () => {
  const pos = () => position() as never;

  it('BUY with quantity and total creates the movement and derives the unit price', async () => {
    db.investmentMovement.findMany.mockResolvedValue([movement('OPENING', '2026-01-10', 10, 1000)]);
    await createMovement(pos(), { type: 'BUY', date: '2026-02-10', quantity: 1, amount: 120 });
    const data = db.investmentMovement.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ positionId: POS, householdId: HH, type: 'BUY' });
    expect(String(data.amount)).toBe('120');
    expect(String(data.unitPrice)).toBe('120');
  });

  it('SELL of more than the position holds is 400 and nothing is written', async () => {
    db.investmentMovement.findMany.mockResolvedValue([movement('OPENING', '2026-01-10', 2, 200)]);
    await expect(createMovement(pos(), { type: 'SELL', date: '2026-02-10', quantity: 3, amount: 330 })).rejects.toMatchObject({ statusCode: 400 });
    expect(db.investmentMovement.create).not.toHaveBeenCalled();
  });

  it('a back-dated SELL that no earlier holding supports is 400', async () => {
    db.investmentMovement.findMany.mockResolvedValue([movement('OPENING', '2026-03-01', 5, 500)]);
    await expect(createMovement(pos(), { type: 'SELL', date: '2026-02-01', quantity: 1, amount: 100 })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a stock movement needs a quantity; income takes none; amount or unit price is required', async () => {
    await expect(createMovement(pos(), { type: 'BUY', date: '2026-02-10', amount: 100 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createMovement(pos(), { type: 'BUY', date: '2026-02-10', quantity: 1 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createMovement(pos(), { type: 'INCOME', date: '2026-02-10', quantity: 1, amount: 5 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createMovement(pos(), { type: 'INCOME', date: '2026-02-10' })).rejects.toMatchObject({ statusCode: 400 });
    expect(db.investmentMovement.create).not.toHaveBeenCalled();
  });

  it('fixed income works with value only: quantity and unit price are refused', async () => {
    const fixed = position({ kind: 'FIXED_INCOME', ticker: null, indexer: 'CDI', rate: dec(100) }) as never;
    await expect(createMovement(fixed, { type: 'BUY', date: '2026-02-10', quantity: 1, amount: 100 })).rejects.toMatchObject({ statusCode: 400 });
    await createMovement(fixed, { type: 'BUY', date: '2026-02-10', amount: 100 });
    expect(db.investmentMovement.create).toHaveBeenCalledTimes(1);
  });

  it('a closed position takes no movement', async () => {
    await expect(createMovement(position({ closedAt: day('2026-06-01') }) as never, { type: 'INCOME', date: '2026-07-01', amount: 5 })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a repeated sourceRef is a 409, not a second movement', async () => {
    db.investmentMovement.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(createMovement(pos(), { type: 'INCOME', date: '2026-02-10', amount: 5, sourceRef: 'xp:abc' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('locks the position row so two sells cannot both pass the check', async () => {
    db.investmentMovement.findMany.mockResolvedValue([movement('OPENING', '2026-01-10', 2, 200)]);
    await createMovement(pos(), { type: 'SELL', date: '2026-02-10', quantity: 1, amount: 110 });
    expect(db.$queryRaw).toHaveBeenCalled();
  });
});

describe('deleteMovement', () => {
  it('refuses a delete that would leave a later sell without the holding it needs', async () => {
    const buy = movement('BUY', '2026-02-01', 5, 500);
    const sell = movement('SELL', '2026-03-01', 5, 600);
    db.investmentMovement.findMany.mockResolvedValue([buy, sell]);
    await expect(deleteMovement(position() as never, buy.id)).rejects.toMatchObject({ statusCode: 400 });
    expect(db.investmentMovement.delete).not.toHaveBeenCalled();
  });
  it('deletes an income', async () => {
    const inc = movement('INCOME', '2026-02-01', null, 5);
    db.investmentMovement.findMany.mockResolvedValue([inc]);
    await deleteMovement(position() as never, inc.id);
    expect(db.investmentMovement.delete).toHaveBeenCalledWith({ where: { id: inc.id } });
  });
  it('a movement of another position is 404', async () => {
    db.investmentMovement.findMany.mockResolvedValue([]);
    await expect(deleteMovement(position() as never, 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('createPosition', () => {
  it('stock: ticker is upper-cased by the schema; the opening becomes an OPENING movement in the same transaction', async () => {
    await createPosition(account() as never, {
      kind: 'STOCK_EXCHANGE',
      ticker: 'TEST11',
      name: 'Fundo Exemplo',
      opening: { date: '2026-01-10', quantity: 10, amount: 1000 },
    });
    expect(db.$transaction).toHaveBeenCalled();
    expect(db.investmentMovement.create.mock.calls[0]![0].data).toMatchObject({ type: 'OPENING', positionId: POS });
  });
  it('stock needs a ticker; fixed income needs an indexer and a rate and takes no ticker', async () => {
    await expect(createPosition(account() as never, { kind: 'STOCK_EXCHANGE', name: 'X' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createPosition(account() as never, { kind: 'FIXED_INCOME', name: 'CDB Exemplo' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      createPosition(account() as never, { kind: 'FIXED_INCOME', name: 'CDB Exemplo', ticker: 'ABCD3', indexer: 'CDI', rate: 100 }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(db.investmentPosition.create).not.toHaveBeenCalled();
  });
  it('a second open position with the same ticker in the account is 409', async () => {
    db.investmentPosition.findFirst.mockResolvedValue(position());
    await expect(createPosition(account() as never, { kind: 'STOCK_EXCHANGE', ticker: 'TEST11', name: 'Fundo Exemplo' })).rejects.toMatchObject({ statusCode: 409 });
  });
  it('a goal of another household is refused', async () => {
    db.savingsGoal.findFirst.mockResolvedValue(null);
    await expect(
      createPosition(account() as never, { kind: 'STOCK_EXCHANGE', ticker: 'ABCD3', name: 'Acao Exemplo', savingsGoalId: GOAL }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(db.savingsGoal.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: GOAL, householdId: HH } }));
  });
});

describe('updatePosition', () => {
  it('closing a stock position that still holds quantity is refused (the user decided on 25/11/2026)', async () => {
    db.investmentMovement.findMany.mockResolvedValue([movement('OPENING', '2026-01-10', 10, 1000)]);
    await expect(updatePosition(position() as never, { closed: true })).rejects.toMatchObject({ statusCode: 400 });
    expect(db.investmentPosition.update).not.toHaveBeenCalled();
  });
  it('closing a stock position sold out is allowed', async () => {
    db.investmentMovement.findMany.mockResolvedValue([movement('OPENING', '2026-01-10', 10, 1000), movement('SELL', '2026-03-10', 10, 1100)]);
    await updatePosition(position() as never, { closed: true });
    expect(db.investmentPosition.update.mock.calls[0]![0].data.closedAt).toBeInstanceOf(Date);
  });
  it('closing a fixed income position with an applied amount is refused; after the full redemption it is allowed', async () => {
    const fixed = position({ kind: 'FIXED_INCOME', ticker: null, indexer: 'CDI', rate: 100 });
    db.investmentMovement.findMany.mockResolvedValue([movement('OPENING', '2026-01-10', null, 500)]);
    await expect(updatePosition(fixed as never, { closed: true })).rejects.toMatchObject({ statusCode: 400 });
    db.investmentMovement.findMany.mockResolvedValue([movement('OPENING', '2026-01-10', null, 500), movement('SELL', '2026-06-10', null, 520)]);
    await updatePosition(fixed as never, { closed: true });
    expect(db.investmentPosition.update).toHaveBeenCalledTimes(1);
  });
  it('closing sets closedAt to today; reopening clears it', async () => {
    await updatePosition(position() as never, { closed: true });
    expect(db.investmentPosition.update.mock.calls[0]![0].data.closedAt).toBeInstanceOf(Date);
    await updatePosition(position({ closedAt: day('2026-06-01') }) as never, { closed: false });
    expect(db.investmentPosition.update.mock.calls[1]![0].data.closedAt).toBeNull();
  });
  it('indexer and rate are for fixed income only', async () => {
    await expect(updatePosition(position() as never, { indexer: 'CDI' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('never counts twice (P21 risk 1)', () => {
  it('every movement type leaves the stored balance and the transactions untouched', async () => {
    db.investmentMovement.findMany.mockResolvedValue([movement('OPENING', '2026-01-10', 10, 1000)]);
    await createMovement(position() as never, { type: 'BUY', date: '2026-02-10', quantity: 1, amount: 120 });
    await createMovement(position() as never, { type: 'SELL', date: '2026-02-11', quantity: 1, amount: 130 });
    await createMovement(position() as never, { type: 'INCOME', date: '2026-02-12', amount: 9.5 });
    await createMovement(position() as never, { type: 'OPENING', date: '2026-02-12', quantity: 1, amount: 100 });
    expect(db.investmentMovement.create).toHaveBeenCalledTimes(4);
    // no `transaction` model and no `account.update` exist in the double: reaching them would have thrown
    expect(db.transaction).toBeUndefined();
    expect(db.account.update).toBeUndefined();
  });
});
