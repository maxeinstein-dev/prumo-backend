import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The goal value reads positions, movements, quotes and rates only: the mock has no write at all.
const db = vi.hoisted(() => {
  const d: Record<string, any> = {
    investmentPosition: { findMany: vi.fn() },
    investmentMovement: { findMany: vi.fn() },
    assetQuote: { findMany: vi.fn() },
    indexRate: { findMany: vi.fn() },
  };
  return d;
});
vi.mock('../../shared/db/prisma.js', () => ({ prisma: db }));

import { goalIdsWithOpenPositions, loadGoalPositionValues } from './investments.goals.js';

// Invented data only.
const HH = '00000000-0000-4000-8000-0000000000f0';
const ACC = '00000000-0000-4000-8000-000000000001';
const G1 = '00000000-0000-4000-8000-0000000000a1';
const G2 = '00000000-0000-4000-8000-0000000000a2';
const P1 = '00000000-0000-4000-8000-000000000010';
const P2 = '00000000-0000-4000-8000-000000000011';
const P3 = '00000000-0000-4000-8000-000000000012';
const dec = (n: number) => ({ toNumber: () => n, toString: () => String(n) });
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

const base = { householdId: HH, accountId: ACC, maturityDate: null, anchorAmount: null, anchorDate: null, closedAt: null };
const stock = (id: string, goal: string | null, ticker: string, over: Record<string, unknown> = {}) => ({ ...base, id, savingsGoalId: goal, kind: 'STOCK_EXCHANGE', ticker, indexer: null, rate: null, ...over });
const cdb = (id: string, goal: string | null, over: Record<string, unknown> = {}) => ({ ...base, id, savingsGoalId: goal, kind: 'FIXED_INCOME', ticker: null, indexer: 'CDI', rate: dec(100), ...over });

let n = 0;
const movement = (positionId: string, type: string, date: string, quantity: number | null, amount: number) => ({
  id: `00000000-0000-4000-8000-0000000002${String(++n).padStart(2, '0')}`,
  positionId, type, date: day(date),
  quantity: quantity === null ? null : dec(quantity),
  unitPrice: quantity === null ? null : dec(amount / quantity),
  amount: dec(amount), notes: null, sourceRef: null, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T12:00:00Z')); // a Monday
  db.investmentPosition.findMany.mockResolvedValue([]);
  db.investmentMovement.findMany.mockResolvedValue([]);
  db.assetQuote.findMany.mockResolvedValue([]);
  db.indexRate.findMany.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe('loadGoalPositionValues', () => {
  it('a goal worth its positions: the sum of the current MARKET value, not of the cost', async () => {
    db.investmentPosition.findMany.mockResolvedValue([stock(P1, G1, 'TEST11'), stock(P2, G1, 'ABCD3')]);
    db.investmentMovement.findMany.mockResolvedValue([
      movement(P1, 'OPENING', '2026-10-01', 10, 100), // cost 100,00
      movement(P2, 'OPENING', '2026-10-01', 2, 40), // cost 40,00
    ]);
    db.assetQuote.findMany.mockResolvedValue([
      { ticker: 'TEST11', date: day('2026-11-06'), close: dec(12.34) }, // 123,40
      { ticker: 'ABCD3', date: day('2026-11-05'), close: dec(30) }, // 60,00
    ]);
    const out = await loadGoalPositionValues([G1]);
    expect(out.get(G1)).toMatchObject({ valueCents: 18340, positionsCount: 2, noQuote: false, estimated: false });
    // the oldest quote date is the honest "as of"
    expect(out.get(G1)!.valueDate).toBe('2026-11-05');
  });

  it('a closed position does not count, in value or in the count', async () => {
    db.investmentPosition.findMany.mockResolvedValue([stock(P1, G1, 'TEST11'), stock(P2, G1, 'ABCD3', { closedAt: day('2026-11-03') })]);
    db.investmentMovement.findMany.mockResolvedValue([
      movement(P1, 'OPENING', '2026-10-01', 10, 100),
      movement(P2, 'OPENING', '2026-10-01', 2, 40),
    ]);
    db.assetQuote.findMany.mockResolvedValue([{ ticker: 'TEST11', date: day('2026-11-06'), close: dec(12.34) }]);
    const out = await loadGoalPositionValues([G1]);
    expect(out.get(G1)).toMatchObject({ valueCents: 12340, positionsCount: 1 });
    // and the query itself leaves the closed ones out
    expect(db.investmentPosition.findMany.mock.calls[0]![0].where).toMatchObject({ closedAt: null });
  });

  it('only closed positions: the goal has no positions at all', async () => {
    db.investmentPosition.findMany.mockResolvedValue([stock(P1, G1, 'TEST11', { closedAt: day('2026-11-03') })]);
    const out = await loadGoalPositionValues([G1]);
    expect(out.has(G1)).toBe(false);
  });

  it('a fixed income is an estimate and a stock without a quote is worth its cost, both flagged', async () => {
    db.investmentPosition.findMany.mockResolvedValue([stock(P1, G1, 'TEST11'), cdb(P2, G1, { anchorAmount: dec(512.34), anchorDate: day('2026-11-09') })]);
    db.investmentMovement.findMany.mockResolvedValue([
      movement(P1, 'OPENING', '2026-10-01', 10, 100),
      movement(P2, 'OPENING', '2026-11-02', null, 500),
    ]);
    const out = await loadGoalPositionValues([G1]);
    // 100,00 (no quote: cost) + 512,34 (anchor of the day, exact)
    expect(out.get(G1)).toMatchObject({ valueCents: 61234, noQuote: true, estimated: true });
    expect(out.get(G1)!.valueDate).toBe('2026-11-09');
  });

  it('a fixed income estimated by the index is flagged as estimated', async () => {
    db.investmentPosition.findMany.mockResolvedValue([cdb(P1, G1)]);
    db.investmentMovement.findMany.mockResolvedValue([movement(P1, 'OPENING', '2026-11-02', null, 500)]);
    db.indexRate.findMany.mockResolvedValue(['02', '03', '04', '05', '06'].map((d) => ({ index: 'CDI', date: day(`2026-11-${d}`), value: dec(0.05) })));
    const out = await loadGoalPositionValues([G1]);
    // 500 x 1,0005^5 = 501,25
    expect(out.get(G1)).toMatchObject({ valueCents: 50125, estimated: true, noQuote: false });
  });

  it('several goals are loaded in batch: one query of each kind, each goal gets only its own positions', async () => {
    db.investmentPosition.findMany.mockResolvedValue([stock(P1, G1, 'TEST11'), stock(P2, G2, 'ABCD3'), stock(P3, G2, 'TEST11')]);
    db.investmentMovement.findMany.mockResolvedValue([
      movement(P1, 'OPENING', '2026-10-01', 10, 100),
      movement(P2, 'OPENING', '2026-10-01', 1, 20),
      movement(P3, 'OPENING', '2026-10-01', 3, 30),
    ]);
    db.assetQuote.findMany.mockResolvedValue([
      { ticker: 'TEST11', date: day('2026-11-06'), close: dec(10) },
      { ticker: 'ABCD3', date: day('2026-11-06'), close: dec(25) },
    ]);
    const out = await loadGoalPositionValues([G1, G2]);
    expect(out.get(G1)).toMatchObject({ valueCents: 10000, positionsCount: 1 });
    expect(out.get(G2)).toMatchObject({ valueCents: 5500, positionsCount: 2 });
    expect(db.investmentPosition.findMany).toHaveBeenCalledTimes(1);
    expect(db.investmentMovement.findMany).toHaveBeenCalledTimes(1);
    expect(db.assetQuote.findMany).toHaveBeenCalledTimes(1);
    expect(db.indexRate.findMany).not.toHaveBeenCalled(); // no CDI position: no rates read
  });

  it('an empty list of goals reads nothing', async () => {
    const out = await loadGoalPositionValues([]);
    expect(out.size).toBe(0);
    expect(db.investmentPosition.findMany).not.toHaveBeenCalled();
  });
});

describe('goalIdsWithOpenPositions', () => {
  it('asks only open positions linked to the goals', async () => {
    db.investmentPosition.findMany.mockResolvedValue([{ savingsGoalId: G1 }]);
    const ids = await goalIdsWithOpenPositions([G1, G2]);
    expect([...ids]).toEqual([G1]);
    expect(db.investmentPosition.findMany.mock.calls[0]![0].where).toMatchObject({ savingsGoalId: { in: [G1, G2] }, closedAt: null });
  });
});
