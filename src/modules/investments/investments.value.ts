import { Prisma } from '../../generated/prisma/client.js';
import { computePosition, divRound, sortMovements, toMicro, type CalcMovement } from './investments.calc.js';

/**
 * Current value of a position (P21 L2). Pure: no database, no clock, no network. Money leaves here as integer cents,
 * rounded once at the end of each position; everything in between is arbitrary-precision decimal, never a float sum.
 *
 * Stock exchange: quantity on the date x the last close up to the date (a newer close is never used). With no close up
 * to the date, quantity x average price (= the cost), marked "no quote".
 *
 * Fixed income (always an estimate, except on the day of a manual anchor):
 *  - Each application grows from its own date; a redemption is taken out of the estimate on its date (never below
 *    zero). Growth is multiplicative, so the value is carried from event to event.
 *  - A manual anchor (the value seen at the broker on a date) replaces everything up to its date: movements dated on or
 *    before it are inside it; later ones are applied on top. A date before the anchor ignores it.
 *  - A rate dated D accrues over day D, so the value on date D holds the rates of the days before D (on the day of the
 *    application it is still the amount applied).
 *  - CDI / SELIC: percent of the daily rate (series 12 / 11, in percent per day) compounded business day by business
 *    day with the stored rates. A weekday with no stored rate inside the stored range is a holiday (no accrual); after
 *    the last stored day the last known rate is carried (before the first one, the first), and the result says so.
 *  - IPCA: monthly rates (series 433, percent per month, dated on the 1st) taken pro rata by days, geometrically, plus
 *    the yearly rate; a month not stored uses the nearest previous (or the first) and the result says so.
 *  - Yearly rates (IPCA+ and prefixed) use 365 calendar days: (1 + r)^(days / 365). A year then yields exactly r, and no
 *    holiday calendar is needed (252 business days per year gives the same year, only the within-year split differs).
 *  - Nothing grows after the maturity.
 */

const D = Prisma.Decimal.clone({ precision: 40, rounding: Prisma.Decimal.ROUND_HALF_UP });
type Dec = InstanceType<typeof D>;

export interface QuoteRow {
  /** 'YYYY-MM-DD' */
  date: string;
  /** Close in reais per unit (up to 6 decimals). */
  close: number;
}

/** CDI/SELIC: percent per day, one per business day. IPCA: percent per month, dated on the 1st of the month. */
export interface RateRow {
  date: string;
  value: number;
}

export interface StockValue {
  valueCents: number;
  costCents: number;
  quantity: number;
  mark: 'MARKET' | 'NO_QUOTE';
  quote: { price: number; date: string } | null;
}

export interface FixedIncomeValue {
  valueCents: number;
  costCents: number;
  mark: 'ANCHOR' | 'ESTIMATED';
  estimated: boolean;
  /** The last known rate (or month) stood in for one that is not stored yet. */
  ratesCarried: boolean;
  /** There was nothing to correct with (no rate stored for the indexer, or no rate informed). */
  ratesMissing: boolean;
}

export function valueStockPosition(input: { movements: CalcMovement[]; quotes: QuoteRow[]; asOf: string }): StockValue {
  const upTo = input.movements.filter((m) => m.date <= input.asOf);
  const figures = computePosition('STOCK_EXCHANGE', upTo);
  const quantity = figures.quantity ?? 0;
  let quote: QuoteRow | null = null;
  for (const q of input.quotes) {
    if (q.date <= input.asOf && (!quote || q.date > quote.date)) quote = q;
  }
  if (!quote || quantity === 0) {
    return {
      valueCents: quantity === 0 ? 0 : figures.costCents,
      costCents: figures.costCents,
      quantity,
      mark: quantity > 0 ? 'NO_QUOTE' : quote ? 'MARKET' : 'NO_QUOTE',
      quote: quote ? { price: quote.close, date: quote.date } : null,
    };
  }
  const valueCents = Number(divRound(BigInt(toMicro(quantity)) * BigInt(Math.round(quote.close * 1_000_000)), 10_000_000_000n));
  return { valueCents, costCents: figures.costCents, quantity, mark: 'MARKET', quote: { price: quote.close, date: quote.date } };
}

// ------------------------------------------------------------------------------------------------- date helpers

const DAY_MS = 86_400_000;
const toMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const toDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): number => Math.round((toMs(to) - toMs(from)) / DAY_MS);
const isWeekday = (ms: number): boolean => {
  const w = new Date(ms).getUTCDay();
  return w !== 0 && w !== 6;
};
const monthStartMs = (y: number, m0: number): number => Date.UTC(y, m0, 1);

// --------------------------------------------------------------------------------------------------------- growth

interface Flags {
  carried: boolean;
}

/** Compounded factor of `pct` percent of the daily rate for every business day in [from, to). */
function dailyFactor(from: string, to: string, pct: number, rates: readonly RateRow[], flags: Flags): Dec {
  let factor = new D(1);
  if (rates.length === 0) return factor;
  const byDate = new Map(rates.map((r) => [r.date, r.value]));
  const sorted = [...rates].sort((a, b) => (a.date < b.date ? -1 : 1));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const share = new D(pct).div(100);
  for (let t = toMs(from); t < toMs(to); t += DAY_MS) {
    if (!isWeekday(t)) continue;
    const day = toDay(t);
    let value = byDate.get(day);
    if (value === undefined) {
      if (day > last.date) {
        value = last.value;
        flags.carried = true;
      } else if (day < first.date) {
        value = first.value;
        flags.carried = true;
      } else {
        continue; // a weekday inside the known range with no rate: holiday
      }
    }
    factor = factor.mul(new D(1).plus(new D(value).div(100).mul(share)));
  }
  return factor;
}

/** IPCA of every month overlapping [from, to), each taken pro rata by the days of the month inside the interval. */
function monthlyFactor(from: string, to: string, rates: readonly RateRow[], flags: Flags): Dec {
  let factor = new D(1);
  if (rates.length === 0) return factor;
  const sorted = [...rates].sort((a, b) => (a.date < b.date ? -1 : 1));
  const byMonth = new Map(sorted.map((r) => [r.date.slice(0, 7), r.value]));
  const fromMs = toMs(from);
  const toMsV = toMs(to);
  let y = new Date(fromMs).getUTCFullYear();
  let m0 = new Date(fromMs).getUTCMonth();
  for (;;) {
    const start = monthStartMs(y, m0);
    if (start >= toMsV) break;
    const end = monthStartMs(y, m0 + 1);
    const overlap = Math.round((Math.min(end, toMsV) - Math.max(start, fromMs)) / DAY_MS);
    if (overlap > 0) {
      const key = toDay(start).slice(0, 7);
      let value = byMonth.get(key);
      if (value === undefined) {
        const previous = [...sorted].reverse().find((r) => r.date.slice(0, 7) < key);
        value = (previous ?? sorted[0]!).value;
        flags.carried = true;
      }
      const monthDays = Math.round((end - start) / DAY_MS);
      factor = factor.mul(new D(1).plus(new D(value).div(100)).pow(new D(overlap).div(monthDays)));
    }
    m0 += 1;
    if (m0 > 11) {
      m0 = 0;
      y += 1;
    }
  }
  return factor;
}

/** (1 + rate%)^(days/365). */
function yearlyFactor(from: string, to: string, ratePct: number): Dec {
  const days = daysBetween(from, to);
  if (days <= 0 || ratePct === 0) return new D(1);
  return new D(1).plus(new D(ratePct).div(100)).pow(new D(days).div(365));
}

export interface FixedIncomeInput {
  movements: CalcMovement[];
  indexer: 'CDI' | 'IPCA' | 'SELIC' | 'PREFIXED' | null;
  /** CDI/SELIC: percent of the index (100 = 100%). IPCA/PREFIXED: percent a year. */
  rate: number | null;
  maturityDate: string | null;
  anchor: { amountCents: number; date: string } | null;
  /** The stored series of the position's indexer (empty for PREFIXED). */
  rates: readonly RateRow[];
  asOf: string;
}

export function valueFixedIncomePosition(input: FixedIncomeInput): FixedIncomeValue {
  const { asOf, maturityDate, anchor } = input;
  const costCents = computePosition('FIXED_INCOME', input.movements.filter((m) => m.date <= asOf)).costCents;
  const flags: Flags = { carried: false };
  let ratesMissing = false;

  const capped = (day: string): string => (maturityDate && day > maturityDate ? maturityDate : day);

  // Growth factor between two days (multiplicative: f(a,c) = f(a,b) x f(b,c)), frozen at the maturity.
  const growth = (from: string, to: string): Dec => {
    const a = capped(from);
    const b = capped(to);
    if (a >= b) return new D(1);
    switch (input.indexer) {
      case 'CDI':
      case 'SELIC':
        if (input.rate === null || input.rates.length === 0) {
          ratesMissing = true;
          return new D(1);
        }
        return dailyFactor(a, b, input.rate, input.rates, flags);
      case 'IPCA': {
        if (input.rates.length === 0) ratesMissing = true;
        return monthlyFactor(a, b, input.rates, flags).mul(yearlyFactor(a, b, input.rate ?? 0));
      }
      case 'PREFIXED':
        if (input.rate === null) {
          ratesMissing = true;
          return new D(1);
        }
        return yearlyFactor(a, b, input.rate);
      default:
        ratesMissing = true;
        return new D(1);
    }
  };

  const useAnchor = anchor !== null && anchor.date <= asOf;
  const ordered = sortMovements(input.movements).filter((m) => m.type !== 'INCOME' && m.date <= asOf && (!useAnchor || m.date > anchor!.date));

  let value = new D(0);
  let cursor = asOf;
  if (useAnchor) {
    value = new D(anchor!.amountCents);
    cursor = anchor!.date;
  } else if (ordered.length > 0) {
    cursor = ordered[0]!.date;
  }
  for (const m of ordered) {
    value = value.mul(growth(cursor, m.date));
    cursor = m.date;
    value = m.type === 'SELL' ? D.max(new D(0), value.minus(m.amountCents)) : value.plus(m.amountCents);
  }
  value = value.mul(growth(cursor, asOf));

  const valueCents = value.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
  const onAnchor = useAnchor && anchor!.date === asOf;
  return {
    valueCents,
    costCents,
    mark: onAnchor ? 'ANCHOR' : 'ESTIMATED',
    estimated: !onAnchor,
    ratesCarried: flags.carried,
    ratesMissing,
  };
}
