import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { recordAccountSnapshots } from './investments.snapshot.js';
import type { BcbClient, MarketIndexName } from './market-data/bcb.client.js';
import type { BrapiClient } from './market-data/brapi.client.js';

/**
 * The daily routine of the investments (P21 L2): fetch the closes of the tickers with an open position, fetch the index
 * rates since the last stored day, save them, and record the snapshot of each account.
 *
 * A fetch problem (no token, timeout, HTTP error, odd answer) is a WARNING: nothing stored is touched (this module has no
 * delete or rewrite of market data), and the snapshot is recorded with the last values known. What fails the run is a
 * real fault: a database error, or an account whose snapshot could not be recorded.
 */

export class InvestmentRefreshError extends Error {
  constructor(public readonly failedAccountIds: string[]) {
    super(`${failedAccountIds.length} investment snapshot(s) failed: ${failedAccountIds.join(', ')}`);
    this.name = 'InvestmentRefreshError';
  }
}

export interface RefreshResult {
  quotesSaved: number;
  ratesSaved: number;
  snapshots: Array<{ accountId: string; totalCents: number }>;
  warnings: string[];
}

interface OpenPosition {
  kind: string;
  ticker: string | null;
  indexer: string | null;
  anchorDate: Date | null;
  movements: Array<{ date: Date }>;
}

const MARKET_INDEXES: readonly MarketIndexName[] = ['CDI', 'SELIC', 'IPCA'];
const MAX_WINDOW_DAYS = 3650; // the Banco Central refuses a daily series for more than ten years

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);
const asDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
const minusDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

export async function runInvestmentRefresh(deps: { brapi: BrapiClient; bcb: BcbClient; today: string }): Promise<RefreshResult> {
  const { brapi, bcb, today } = deps;
  const warnings: string[] = [];

  const positions = (await prisma.investmentPosition.findMany({
    where: { closedAt: null },
    select: {
      kind: true,
      ticker: true,
      indexer: true,
      anchorDate: true,
      movements: { select: { date: true }, orderBy: { date: 'asc' }, take: 1 },
    },
  })) as unknown as OpenPosition[];

  // ---- quotes
  let quotesSaved = 0;
  const tickers = [...new Set(positions.filter((p) => p.kind === 'STOCK_EXCHANGE' && p.ticker).map((p) => p.ticker!))];
  if (tickers.length > 0) {
    const fetched = await brapi.fetchQuotes(tickers);
    warnings.push(...fetched.warnings);
    for (const q of fetched.quotes) {
      const date = asDate(q.date);
      const close = new Prisma.Decimal(q.close);
      await prisma.assetQuote.upsert({
        where: { ticker_date: { ticker: q.ticker, date } },
        create: { ticker: q.ticker, date, close, source: 'brapi' },
        update: { close, source: 'brapi' },
      });
      quotesSaved += 1;
    }
  }

  // ---- index rates
  let ratesSaved = 0;
  for (const index of MARKET_INDEXES) {
    const mine = positions.filter((p) => p.kind === 'FIXED_INCOME' && p.indexer === index);
    if (mine.length === 0) continue;
    const dates = mine.flatMap((p) => [p.movements[0] ? dayOf(p.movements[0].date) : null, p.anchorDate ? dayOf(p.anchorDate) : null]).filter((d): d is string => d !== null);
    if (dates.length === 0) continue;
    let needed = dates.sort()[0]!;
    if (index === 'IPCA') needed = `${needed.slice(0, 7)}-01`;
    const floor = minusDays(today, MAX_WINDOW_DAYS);
    if (needed < floor) needed = floor;

    const stored = await prisma.indexRate.aggregate({ where: { index }, _min: { date: true }, _max: { date: true } });
    const storedMin = stored._min.date ? dayOf(stored._min.date) : null;
    const storedMax = stored._max.date ? dayOf(stored._max.date) : null;
    const from = storedMin === null || storedMax === null || needed < storedMin ? needed : index === 'IPCA' ? `${storedMax.slice(0, 7)}-01` : storedMax;
    if (from > today) continue;

    const fetched = await bcb.fetchSeries(index, from, today);
    warnings.push(...fetched.warnings);
    if (fetched.rates.length > 0) {
      const result = await prisma.indexRate.createMany({
        data: fetched.rates.map((r) => ({ index, date: asDate(r.date), value: new Prisma.Decimal(r.value), source: 'bcb' })),
        skipDuplicates: true,
      });
      ratesSaved += result?.count ?? fetched.rates.length;
    }
  }

  // ---- snapshots (always, with the last values known)
  const snapshot = await recordAccountSnapshots(today);
  if (snapshot.failedAccountIds.length > 0) throw new InvestmentRefreshError(snapshot.failedAccountIds);
  return { quotesSaved, ratesSaved, snapshots: snapshot.recorded, warnings };
}
