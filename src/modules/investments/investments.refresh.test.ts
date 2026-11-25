import { beforeEach, describe, expect, it, vi } from 'vitest';

// No `delete`, `deleteMany` or `update` on the market tables: a failed fetch can never erase what is stored.
const db = vi.hoisted(() => {
  const d: Record<string, any> = {
    investmentPosition: { findMany: vi.fn() },
    assetQuote: { upsert: vi.fn(), groupBy: vi.fn() },
    indexRate: { aggregate: vi.fn(), createMany: vi.fn() },
  };
  return d;
});
vi.mock('../../shared/db/prisma.js', () => ({ prisma: db }));

const snapshots = vi.hoisted(() => ({ recordAccountSnapshots: vi.fn() }));
vi.mock('./investments.snapshot.js', () => snapshots);

import { InvestmentRefreshError, runInvestmentRefresh } from './investments.refresh.js';
import type { BcbClient } from './market-data/bcb.client.js';
import type { BrapiClient } from './market-data/brapi.client.js';

// Invented data only.
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const stock = (ticker: string) => ({ kind: 'STOCK_EXCHANGE', ticker, indexer: null, anchorDate: null, movements: [{ date: day('2026-10-01') }] });
const fixed = (indexer: string, first = '2026-11-02', anchor: string | null = null) => ({
  kind: 'FIXED_INCOME', ticker: null, indexer, anchorDate: anchor ? day(anchor) : null, movements: [{ date: day(first) }],
});

let brapi: { fetchQuotes: ReturnType<typeof vi.fn> };
let bcb: { fetchSeries: ReturnType<typeof vi.fn> };
const run = () => runInvestmentRefresh({ brapi: brapi as unknown as BrapiClient, bcb: bcb as unknown as BcbClient, today: '2026-11-25' });

beforeEach(() => {
  vi.clearAllMocks();
  db.investmentPosition.findMany.mockResolvedValue([stock('TEST11'), stock('ABCD3'), stock('TEST11'), fixed('CDI')]);
  db.assetQuote.upsert.mockResolvedValue({});
  db.assetQuote.groupBy.mockResolvedValue([{ ticker: 'TEST11', _max: { date: day('2026-11-25') } }, { ticker: 'ABCD3', _max: { date: day('2026-11-25') } }]);
  db.indexRate.aggregate.mockResolvedValue({ _min: { date: null }, _max: { date: null } });
  db.indexRate.createMany.mockResolvedValue({ count: 0 });
  snapshots.recordAccountSnapshots.mockResolvedValue({ recorded: [{ accountId: 'a', totalCents: 1 }], failedAccountIds: [] });
  brapi = { fetchQuotes: vi.fn(async () => ({ quotes: [{ ticker: 'TEST11', date: '2026-11-25', close: 10.5 }, { ticker: 'ABCD3', date: '2026-11-25', close: 20 }], warnings: [] })) };
  bcb = { fetchSeries: vi.fn(async () => ({ rates: [{ date: '2026-11-24', value: 0.05 }], warnings: [] })) };
});

describe('runInvestmentRefresh', () => {
  it('asks the quotes of the open stock positions with a single fetchQuotes call, each ticker once', async () => {
    await run();
    expect(brapi.fetchQuotes).toHaveBeenCalledTimes(1);
    expect(brapi.fetchQuotes.mock.calls[0]![0].sort()).toEqual(['ABCD3', 'TEST11']);
    expect(db.investmentPosition.findMany.mock.calls[0]![0].where).toEqual({ closedAt: null });
  });

  it('saves each close once per ticker and day (upsert) with its source', async () => {
    const r = await run();
    expect(db.assetQuote.upsert).toHaveBeenCalledTimes(2);
    const first = db.assetQuote.upsert.mock.calls[0]![0];
    expect(first.where).toEqual({ ticker_date: { ticker: 'TEST11', date: day('2026-11-25') } });
    expect(first.create).toMatchObject({ ticker: 'TEST11', source: 'brapi' });
    expect(first.create.close.toString()).toBe('10.5');
    expect(r.quotesSaved).toBe(2);
  });

  it('the first run asks the CDI since the oldest date of the positions, up to today', async () => {
    await run();
    expect(bcb.fetchSeries).toHaveBeenCalledTimes(1);
    expect(bcb.fetchSeries).toHaveBeenCalledWith('CDI', '2026-11-02', '2026-11-25');
  });

  it('an anchor older than the first movement widens the window', async () => {
    db.investmentPosition.findMany.mockResolvedValue([fixed('CDI', '2026-11-02', '2026-10-15')]);
    await run();
    expect(bcb.fetchSeries).toHaveBeenCalledWith('CDI', '2026-10-15', '2026-11-25');
  });

  it('later runs ask from the last stored day on, and store with skipDuplicates', async () => {
    db.indexRate.aggregate.mockResolvedValue({ _min: { date: day('2026-11-02') }, _max: { date: day('2026-11-20') } });
    db.indexRate.createMany.mockResolvedValue({ count: 1 });
    const r = await run();
    expect(bcb.fetchSeries).toHaveBeenCalledWith('CDI', '2026-11-20', '2026-11-25');
    const call = db.indexRate.createMany.mock.calls[0]![0];
    expect(call.skipDuplicates).toBe(true);
    expect(call.data).toEqual([expect.objectContaining({ index: 'CDI', date: day('2026-11-24'), source: 'bcb' })]);
    expect(call.data[0].value.toString()).toBe('0.05');
    expect(r.ratesSaved).toBe(1);
  });

  it('a position older than what is stored goes back to its date', async () => {
    db.indexRate.aggregate.mockResolvedValue({ _min: { date: day('2026-11-10') }, _max: { date: day('2026-11-20') } });
    await run();
    expect(bcb.fetchSeries).toHaveBeenCalledWith('CDI', '2026-11-02', '2026-11-25');
  });

  it('IPCA starts on the 1st of the month of the oldest date; prefixed asks for nothing', async () => {
    db.investmentPosition.findMany.mockResolvedValue([fixed('IPCA', '2026-03-17'), fixed('PREFIXED', '2026-01-02')]);
    await run();
    expect(bcb.fetchSeries).toHaveBeenCalledTimes(1);
    expect(bcb.fetchSeries).toHaveBeenCalledWith('IPCA', '2026-03-01', '2026-11-25');
  });

  it('asks only the indexes in use, and nothing from the Banco Central without fixed income', async () => {
    db.investmentPosition.findMany.mockResolvedValue([stock('TEST11')]);
    await run();
    expect(bcb.fetchSeries).not.toHaveBeenCalled();
  });

  it('no stock position: brapi is not called', async () => {
    db.investmentPosition.findMany.mockResolvedValue([fixed('CDI')]);
    await run();
    expect(brapi.fetchQuotes).not.toHaveBeenCalled();
  });

  it('a failed quote fetch keeps what is stored, warns, and the snapshots still run', async () => {
    brapi.fetchQuotes.mockResolvedValue({ quotes: [], warnings: ['brapi unavailable (timeout): quotes not updated'] });
    const r = await run();
    expect(r.warnings).toContain('brapi unavailable (timeout): quotes not updated');
    expect(db.assetQuote.upsert).not.toHaveBeenCalled();
    expect(snapshots.recordAccountSnapshots).toHaveBeenCalledWith('2026-11-25');
    expect(r.quotesSaved).toBe(0);
  });

  it('a failed Banco Central fetch keeps what is stored, warns, and the snapshots still run', async () => {
    bcb.fetchSeries.mockResolvedValue({ rates: [], warnings: ['Banco Central unavailable (network error) for CDI: rates not updated'] });
    const r = await run();
    expect(r.warnings.join(' ')).toMatch(/Banco Central unavailable/);
    expect(db.indexRate.createMany).not.toHaveBeenCalled();
    expect(snapshots.recordAccountSnapshots).toHaveBeenCalled();
  });

  it('never deletes or rewrites market data (the tables have no delete in the test double)', async () => {
    brapi.fetchQuotes.mockResolvedValue({ quotes: [], warnings: ['x'] });
    bcb.fetchSeries.mockResolvedValue({ rates: [], warnings: ['y'] });
    await expect(run()).resolves.toBeDefined();
  });

  it('the snapshots take the day of the run and are reported', async () => {
    const r = await run();
    expect(snapshots.recordAccountSnapshots).toHaveBeenCalledWith('2026-11-25');
    expect(r.snapshots).toEqual([{ accountId: 'a', totalCents: 1 }]);
  });

  it('a snapshot that fails really fails the run, naming only account ids, after everything else was done', async () => {
    snapshots.recordAccountSnapshots.mockResolvedValue({ recorded: [], failedAccountIds: ['acc-9'] });
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(InvestmentRefreshError);
    expect(err.failedAccountIds).toEqual(['acc-9']);
    expect(err.message).toContain('acc-9');
    expect(db.assetQuote.upsert).toHaveBeenCalled();
  });

  it('a database failure while saving is not swallowed', async () => {
    db.assetQuote.upsert.mockRejectedValue(new Error('db down'));
    await expect(run()).rejects.toThrow('db down');
  });

  it('reports what is still stale in the stored data: the tickers whose fetch failed and that have no recent close', async () => {
    brapi.fetchQuotes.mockResolvedValue({ quotes: [], warnings: ['brapi refused the request'] });
    db.assetQuote.groupBy.mockResolvedValue([{ ticker: 'TEST11', _max: { date: day('2026-11-24') } }]);
    const r = await run();
    expect(r.stale.staleTickers).toBe(1); // ABCD3 was never quoted; TEST11 has yesterday's close
    expect(snapshots.recordAccountSnapshots).toHaveBeenCalled(); // the snapshots were still recorded
  });

  it('nothing is stale when the closes are fresh and the CDI just came into use', async () => {
    db.investmentPosition.findMany.mockResolvedValue([stock('TEST11'), stock('ABCD3'), fixed('CDI', '2026-11-24')]);
    const r = await run();
    expect(r.stale).toEqual({ staleTickers: 0, staleIndexes: [] });
  });

  it('a CDI in use for weeks with no stored rate is stale', async () => {
    db.investmentPosition.findMany.mockResolvedValue([fixed('CDI', '2026-10-01')]);
    bcb.fetchSeries.mockResolvedValue({ rates: [], warnings: ['Banco Central unavailable'] });
    const r = await run();
    expect(r.stale.staleIndexes).toEqual(['CDI']);
  });
});
