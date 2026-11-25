/**
 * Stale market data (decided on 25/11/2026). A fetch problem is only a warning for the routine, so a quote service that
 * refuses every request (wrong key, plan limit, a new answer format) would leave the run green while the positions
 * silently fall back to their cost. The routine checks what is STORED after the fetch: a ticker with an open position
 * whose last close is older than QUOTE_MAX_AGE_DAYS (or that was never quoted), or an index in use with no rate for
 * longer than its publication rhythm allows, fails the run, and the daily workflow opens its issue (e-mail).
 */
export const QUOTE_MAX_AGE_DAYS = 4; // a weekend plus a holiday (carnival: Friday close read on Wednesday morning is 5)
export const DAILY_RATE_MAX_AGE_DAYS = 7; // CDI and Selic come one business day later
export const MONTHLY_RATE_MAX_AGE_DAYS = 75; // IPCA of a month is published around the 10th of the next one

export interface StaleInput {
  today: string;
  tickers: Array<{ ticker: string; lastQuoteDay: string | null }>;
  /** `inUseSince`: the oldest day a position of this index needs (a new index gets the same grace period). */
  indexes: Array<{ index: string; inUseSince: string; lastRateDay: string | null }>;
}

export interface StaleResult {
  staleTickers: number;
  staleIndexes: string[];
}

const minusDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

export function staleMarketData(input: StaleInput): StaleResult {
  const quoteFloor = minusDays(input.today, QUOTE_MAX_AGE_DAYS);
  const staleTickers = input.tickers.filter((t) => t.lastQuoteDay === null || t.lastQuoteDay < quoteFloor).length;
  const staleIndexes = input.indexes
    .filter((i) => {
      const maxAge = i.index === 'IPCA' ? MONTHLY_RATE_MAX_AGE_DAYS : DAILY_RATE_MAX_AGE_DAYS;
      const reference = i.lastRateDay !== null && i.lastRateDay > i.inUseSince ? i.lastRateDay : i.inUseSince;
      return reference < minusDays(input.today, maxAge);
    })
    .map((i) => i.index);
  return { staleTickers, staleIndexes };
}

/** Counts and index names only: the workflow log of the ops repository is public, so no ticker is named. */
export class StaleMarketDataError extends Error {
  constructor(stale: StaleResult) {
    const parts: string[] = [];
    if (stale.staleTickers > 0) parts.push(`${stale.staleTickers} ticker(s) with an open position have no close in the last ${QUOTE_MAX_AGE_DAYS} days`);
    if (stale.staleIndexes.length > 0) parts.push(`no recent rate for ${stale.staleIndexes.join(', ')}`);
    super(`Market data is stale: ${parts.join('; ')}. See the warnings above.`);
    this.name = 'StaleMarketDataError';
  }
}

export const isStale = (s: StaleResult | undefined): s is StaleResult => !!s && (s.staleTickers > 0 || s.staleIndexes.length > 0);
