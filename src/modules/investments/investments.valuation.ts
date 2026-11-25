import { prisma } from '../../shared/db/prisma.js';
import type { CalcMovement, PositionKind } from './investments.calc.js';
import { valueFixedIncomePosition, valueStockPosition, type QuoteRow, type RateRow } from './investments.value.js';

/**
 * Database side of the current value of the positions (P21 L2): loads the quotes and index rates a set of positions needs
 * and applies the pure rules of investments.value.ts. Reads only; nothing here writes.
 */

type MarketIndex = 'CDI' | 'SELIC' | 'IPCA';
interface DecimalLike {
  toNumber(): number;
}

export interface MarketData {
  /** Closes up to the date asked, by ticker. */
  quotes: Map<string, QuoteRow[]>;
  /** Stored series, by index. */
  rates: Map<string, RateRow[]>;
}

export interface ValuablePosition {
  kind: PositionKind;
  ticker: string | null;
  indexer: string | null;
  rate: DecimalLike | null;
  maturityDate: Date | null;
  anchorAmount: DecimalLike | null;
  anchorDate: Date | null;
  closedAt: Date | null;
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);
const asDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

export async function loadMarketData(positions: readonly ValuablePosition[], asOf: string): Promise<MarketData> {
  const open = positions.filter((p) => p.closedAt === null);
  const tickers = [...new Set(open.filter((p) => p.kind === 'STOCK_EXCHANGE' && p.ticker).map((p) => p.ticker!))];
  const indexes = [...new Set(open.filter((p) => p.kind === 'FIXED_INCOME' && (p.indexer === 'CDI' || p.indexer === 'SELIC' || p.indexer === 'IPCA')).map((p) => p.indexer as MarketIndex))];

  const quotes = new Map<string, QuoteRow[]>();
  if (tickers.length > 0) {
    // The latest close of each ticker up to the day (a newer one is never read).
    const rows = (await prisma.assetQuote.findMany({
      where: { ticker: { in: tickers }, date: { lte: asDate(asOf) } },
      orderBy: [{ ticker: 'asc' }, { date: 'desc' }],
      distinct: ['ticker'],
    })) as unknown as Array<{ ticker: string; date: Date; close: DecimalLike }>;
    for (const r of rows) quotes.set(r.ticker, [{ date: dayOf(r.date), close: r.close.toNumber() }]);
  }

  const rates = new Map<string, RateRow[]>();
  if (indexes.length > 0) {
    const rows = (await prisma.indexRate.findMany({
      where: { index: { in: indexes } },
      orderBy: { date: 'asc' },
    })) as unknown as Array<{ index: string; date: Date; value: DecimalLike }>;
    for (const r of rows) rates.set(r.index, [...(rates.get(r.index) ?? []), { date: dayOf(r.date), value: r.value.toNumber() }]);
  }
  return { quotes, rates };
}

export type ValueMark = 'MARKET' | 'NO_QUOTE' | 'ANCHOR' | 'ESTIMATED' | 'CLOSED';

export interface PositionValuation {
  valueCents: number;
  costCents: number;
  valueMark: ValueMark;
  /** Day of the quote used (stock) or of the estimate (fixed income); null without a quote. */
  valueDate: string | null;
  estimated: boolean;
  noQuote: boolean;
  ratesCarried: boolean;
  ratesMissing: boolean;
  lastQuote: { price: number; date: string } | null;
}

export function valuePosition(p: ValuablePosition, movements: CalcMovement[], market: MarketData, asOf: string): PositionValuation {
  if (p.closedAt !== null) {
    return { valueCents: 0, costCents: 0, valueMark: 'CLOSED', valueDate: null, estimated: false, noQuote: false, ratesCarried: false, ratesMissing: false, lastQuote: null };
  }
  if (p.kind === 'STOCK_EXCHANGE') {
    const v = valueStockPosition({ movements, quotes: (p.ticker ? market.quotes.get(p.ticker) : undefined) ?? [], asOf });
    return {
      valueCents: v.valueCents,
      costCents: v.costCents,
      valueMark: v.mark,
      valueDate: v.quote?.date ?? null,
      estimated: false,
      noQuote: v.mark === 'NO_QUOTE',
      ratesCarried: false,
      ratesMissing: false,
      lastQuote: v.quote,
    };
  }
  const v = valueFixedIncomePosition({
    movements,
    indexer: p.indexer as 'CDI' | 'IPCA' | 'SELIC' | 'PREFIXED' | null,
    rate: p.rate ? p.rate.toNumber() : null,
    maturityDate: p.maturityDate ? dayOf(p.maturityDate) : null,
    anchor: p.anchorAmount && p.anchorDate ? { amountCents: Math.round(p.anchorAmount.toNumber() * 100), date: dayOf(p.anchorDate) } : null,
    rates: (p.indexer ? market.rates.get(p.indexer) : undefined) ?? [],
    asOf,
  });
  return {
    valueCents: v.valueCents,
    costCents: v.costCents,
    valueMark: v.mark,
    valueDate: asOf,
    estimated: v.estimated,
    noQuote: false,
    ratesCarried: v.ratesCarried,
    ratesMissing: v.ratesMissing,
    lastQuote: null,
  };
}
