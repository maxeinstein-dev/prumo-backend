import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same discipline as investments.service.test.ts: the mock has no `transaction` model and no `account.update`.
const db = vi.hoisted(() => {
  const d: Record<string, any> = {
    account: { findUnique: vi.fn(), findMany: vi.fn() },
    investmentPosition: { findMany: vi.fn(), findUnique: vi.fn() },
    investmentMovement: { findMany: vi.fn() },
    assetQuote: { findMany: vi.fn() },
    indexRate: { findMany: vi.fn() },
    accountValuation: { upsert: vi.fn() },
  };
  return d;
});
vi.mock('../../shared/db/prisma.js', () => ({ prisma: db }));

import { getPositionDetail, listPositions } from './investments.service.js';
import { recordAccountSnapshots } from './investments.snapshot.js';

// Invented data only.
const HH = '00000000-0000-4000-8000-0000000000f0';
const ACC = '00000000-0000-4000-8000-000000000001';
const ACC2 = '00000000-0000-4000-8000-000000000002';
const STOCK = '00000000-0000-4000-8000-000000000010';
const CDB = '00000000-0000-4000-8000-000000000011';
const dec = (n: number) => ({ toNumber: () => n, toString: () => String(n) });
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

const account = (over: Record<string, unknown> = {}) => ({
  id: ACC, householdId: HH, name: 'Corretora Exemplo', type: 'INVESTMENT', isActive: true, balance: dec(1000), ...over,
});
const base = { householdId: HH, accountId: ACC, savingsGoalId: null, maturityDate: null, anchorAmount: null, anchorDate: null, closedAt: null, createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'), account: account() };
const stock = (over: Record<string, unknown> = {}) => ({ ...base, id: STOCK, kind: 'STOCK_EXCHANGE', ticker: 'TEST11', name: 'Fundo Exemplo', indexer: null, rate: null, ...over });
const cdb = (over: Record<string, unknown> = {}) => ({ ...base, id: CDB, kind: 'FIXED_INCOME', ticker: null, name: 'CDB Exemplo', indexer: 'CDI', rate: dec(100), ...over });

let n = 0;
const movement = (positionId: string, type: string, date: string, quantity: number | null, amount: number) => ({
  id: `00000000-0000-4000-8000-0000000002${String(++n).padStart(2, '0')}`,
  householdId: HH, positionId, type, date: day(date),
  quantity: quantity === null ? null : dec(quantity),
  unitPrice: quantity === null ? null : dec(amount / quantity),
  amount: dec(amount), notes: null, sourceRef: null, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
});

/** CDI of 0,05% a day on every business day between the two days. */
function cdiRows(from: string, to: string) {
  const rows: Array<{ index: string; date: Date; value: ReturnType<typeof dec> }> = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) {
    const w = new Date(t).getUTCDay();
    if (w !== 0 && w !== 6) rows.push({ index: 'CDI', date: new Date(t), value: dec(0.05) });
  }
  return rows;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T12:00:00Z')); // a Monday
  db.investmentPosition.findMany.mockResolvedValue([stock(), cdb()]);
  db.investmentMovement.findMany.mockResolvedValue([
    movement(STOCK, 'OPENING', '2026-10-01', 10, 100), // 10 units, cost 100,00
    movement(CDB, 'OPENING', '2026-11-02', null, 500), // 500,00 from Monday 11-02
  ]);
  db.assetQuote.findMany.mockResolvedValue([{ ticker: 'TEST11', date: day('2026-11-06'), close: dec(12.34) }]);
  db.indexRate.findMany.mockResolvedValue(cdiRows('2026-11-02', '2026-11-06'));
  db.accountValuation.upsert.mockImplementation(async (a: unknown) => a);
});
afterEach(() => vi.useRealTimers());

describe('listPositions with market values', () => {
  it('each position gets value, result, date and mark; the account total is the positions plus the cash', async () => {
    const res = await listPositions(account() as never, {});
    const s = res.positions.find((p) => p.id === STOCK)!;
    // 10 x 12,34 = 123,40 against a cost of 100,00
    expect(s).toMatchObject({ currentValue: 123.4, result: 23.4, valueDate: '2026-11-06', valueMark: 'MARKET', noQuote: false, estimated: false });
    const f = res.positions.find((p) => p.id === CDB)!;
    // 500 x 1,0005^5 (02..06) = 501,25125 -> 501,25 against a cost of 500,00; estimated
    expect(f).toMatchObject({ currentValue: 501.25, result: 1.25, valueMark: 'ESTIMATED', estimated: true, noQuote: false, valueDate: '2026-11-09' });
    // cash: 1000,00 in the account, openings take nothing
    expect(res.summary.cashBalance).toBe(1000);
    expect(res.summary.positionsValue).toBe(624.65);
    expect(res.summary.positionsResult).toBe(24.65);
    expect(res.summary.totalValue).toBe(1624.65);
    expect(res.summary.valuedAt).toBe('2026-11-09');
    expect(res.summary.hasEstimates).toBe(true);
    expect(res.summary.hasNoQuote).toBe(false);
    // the fields of the L1 contract stay
    expect(res.summary.totalAtCost).toBe(1600);
    expect(res.summary.positionsCost).toBe(600);
    expect(s.costAmount).toBe(100);
  });

  it('asks for the closes up to today, not any newer one', async () => {
    await listPositions(account() as never, {});
    const where = db.assetQuote.findMany.mock.calls[0]![0].where;
    expect(where.ticker).toEqual({ in: ['TEST11'] });
    expect(where.date).toEqual({ lte: day('2026-11-09') });
  });

  it('without a quote the stock is worth its cost and is marked "no quote"', async () => {
    db.assetQuote.findMany.mockResolvedValue([]);
    const res = await listPositions(account() as never, {});
    const s = res.positions.find((p) => p.id === STOCK)!;
    expect(s).toMatchObject({ currentValue: 100, result: 0, valueMark: 'NO_QUOTE', noQuote: true, valueDate: null });
    expect(res.summary.hasNoQuote).toBe(true);
  });

  it('the cash at the broker is added to the total (buy and income move it)', async () => {
    db.investmentMovement.findMany.mockResolvedValue([
      movement(STOCK, 'OPENING', '2026-10-01', 10, 100),
      movement(STOCK, 'BUY', '2026-11-03', 1, 11), // -11,00 of cash, 11 units now
      movement(STOCK, 'INCOME', '2026-11-04', null, 8.5), // +8,50 of cash
      movement(CDB, 'OPENING', '2026-11-02', null, 500),
    ]);
    const res = await listPositions(account() as never, {});
    // stock: 11 x 12,34 = 135,74; cash 1000 - 11 + 8,5 = 997,5; cdb 501,25
    expect(res.summary.cashBalance).toBe(997.5);
    expect(res.summary.positionsValue).toBe(636.99);
    expect(res.summary.totalValue).toBe(1634.49);
  });

  it('a closed position is worth zero and is out of the total', async () => {
    db.investmentPosition.findMany.mockResolvedValue([stock({ closedAt: day('2026-11-05') }), cdb()]);
    db.investmentMovement.findMany.mockResolvedValue([
      movement(STOCK, 'OPENING', '2026-10-01', 10, 100),
      movement(STOCK, 'SELL', '2026-11-05', 10, 120),
      movement(CDB, 'OPENING', '2026-11-02', null, 500),
    ]);
    const res = await listPositions(account() as never, { includeClosed: true });
    expect(res.positions.find((p) => p.id === STOCK)).toMatchObject({ currentValue: 0, valueMark: 'CLOSED' });
    expect(res.summary.positionsValue).toBe(501.25);
    expect(res.summary.cashBalance).toBe(1120); // 1000 + 120 of the sale
    expect(res.summary.totalValue).toBe(1621.25);
  });

  it('a manual anchor on the day is the value, not an estimate', async () => {
    db.investmentPosition.findMany.mockResolvedValue([cdb({ anchorAmount: dec(512.34), anchorDate: day('2026-11-09') })]);
    const res = await listPositions(account() as never, {});
    expect(res.positions[0]).toMatchObject({ currentValue: 512.34, valueMark: 'ANCHOR', estimated: false });
    expect(res.summary.hasEstimates).toBe(false);
  });

  it('loads only the series the positions need (CDI here, never the IPCA)', async () => {
    await listPositions(account() as never, {});
    expect(db.indexRate.findMany.mock.calls[0]![0].where.index).toEqual({ in: ['CDI'] });
  });

  it('a SELIC position reads the SELIC series, not the CDI one', async () => {
    db.investmentPosition.findMany.mockResolvedValue([cdb({ indexer: 'SELIC' })]);
    db.indexRate.findMany.mockResolvedValue([]);
    await listPositions(account() as never, {});
    expect(db.indexRate.findMany.mock.calls[0]![0].where.index).toEqual({ in: ['SELIC'] });
  });

  it('the detail of a position carries the same value fields', async () => {
    db.investmentPosition.findUnique.mockResolvedValue(stock());
    const all = await db.investmentMovement.findMany();
    db.investmentMovement.findMany.mockImplementation(async (a: { where: { positionId?: string } }) => (a?.where?.positionId ? all.filter((m: { positionId: string }) => m.positionId === a.where.positionId) : all));
    const d = await getPositionDetail(stock() as never);
    expect(d).toMatchObject({ currentValue: 123.4, result: 23.4, valueMark: 'MARKET' });
  });
});

describe('recordAccountSnapshots (the daily picture in account_valuations)', () => {
  beforeEach(() => {
    db.investmentPosition.findMany.mockImplementation(async (args: { distinct?: string[] }) => (args?.distinct ? [{ accountId: ACC }] : [stock(), cdb()]));
    db.account.findUnique.mockResolvedValue(account());
  });

  it('writes the account total (positions + cash) with the day, one row per account and day', async () => {
    const r = await recordAccountSnapshots('2026-11-09');
    expect(r).toEqual({ recorded: [{ accountId: ACC, totalCents: 162465 }], failedAccountIds: [] });
    expect(db.accountValuation.upsert).toHaveBeenCalledTimes(1);
    const call = db.accountValuation.upsert.mock.calls[0]![0];
    expect(call.where).toEqual({ accountId_date: { accountId: ACC, date: day('2026-11-09') } });
    expect(call.create.amount.toString()).toBe('1624.65');
    expect(call.update.amount.toString()).toBe('1624.65');
  });

  it('is idempotent: running twice writes the same figure on the same key (an upsert, never a second row)', async () => {
    await recordAccountSnapshots('2026-11-09');
    await recordAccountSnapshots('2026-11-09');
    const [a, b] = db.accountValuation.upsert.mock.calls.map((c: unknown[]) => c[0] as { where: unknown; update: { amount: { toString(): string } } });
    expect(a!.where).toEqual(b!.where);
    expect(a!.update.amount.toString()).toBe(b!.update.amount.toString());
  });

  it('only looks at active investment accounts that have a position', async () => {
    await recordAccountSnapshots('2026-11-09');
    const q = db.investmentPosition.findMany.mock.calls.find((c: unknown[]) => (c[0] as { distinct?: unknown }).distinct)![0];
    expect(q.where).toEqual({ account: { isActive: true, type: 'INVESTMENT' } });
    expect(q.distinct).toEqual(['accountId']);
  });

  it('an account with no position is never written (its typed value stays the only one)', async () => {
    db.investmentPosition.findMany.mockImplementation(async () => []);
    db.account.findMany.mockResolvedValue([account()]); // an investment account exists, but holds no position
    const r = await recordAccountSnapshots('2026-11-09');
    expect(r.recorded).toEqual([]);
    expect(db.accountValuation.upsert).not.toHaveBeenCalled();
  });

  it('a failing account is reported by id and does not stop the others', async () => {
    db.investmentPosition.findMany.mockImplementation(async (args: { distinct?: string[]; where?: { accountId?: string } }) =>
      args?.distinct ? [{ accountId: ACC }, { accountId: ACC2 }] : [stock({ accountId: args?.where?.accountId }), cdb()]);
    db.account.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === ACC) throw new Error('boom 1000.00 Corretora Exemplo');
      return account({ id: ACC2 });
    });
    const r = await recordAccountSnapshots('2026-11-09');
    expect(r.failedAccountIds).toEqual([ACC]);
    expect(r.recorded.map((x) => x.accountId)).toEqual([ACC2]);
    expect(JSON.stringify(r)).not.toContain('Corretora');
  });

  it('uses the last quote when there is no newer one (a failed fetch leaves the old figure standing)', async () => {
    db.assetQuote.findMany.mockResolvedValue([{ ticker: 'TEST11', date: day('2026-11-02'), close: dec(11) }]);
    const r = await recordAccountSnapshots('2026-11-09');
    // stock 10 x 11,00 = 110,00; cdb 501,25; cash 1000,00
    expect(r.recorded[0]!.totalCents).toBe(161125);
  });
});
