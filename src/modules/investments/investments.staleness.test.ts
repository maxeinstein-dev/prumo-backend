import { describe, expect, it } from 'vitest';
import { QUOTE_MAX_AGE_DAYS, DAILY_RATE_MAX_AGE_DAYS, MONTHLY_RATE_MAX_AGE_DAYS, staleMarketData, StaleMarketDataError } from './investments.staleness.js';

// Invented tickers only. The rule: a routine that "ends well" while the quotes or the index rates stopped arriving must
// fail instead, so the daily workflow opens its issue (e-mail) the first day the data goes stale.
const TODAY = '2026-11-25';

describe('staleMarketData', () => {
  it('a ticker never quoted is stale (the first fetch failed)', () => {
    const r = staleMarketData({ today: TODAY, tickers: [{ ticker: 'TEST11', lastQuoteDay: null }], indexes: [] });
    expect(r.staleTickers).toBe(1);
  });

  it(`a close up to ${QUOTE_MAX_AGE_DAYS} days old is fine (weekend and a holiday); one day more is stale`, () => {
    expect(QUOTE_MAX_AGE_DAYS).toBe(4);
    expect(staleMarketData({ today: TODAY, tickers: [{ ticker: 'TEST11', lastQuoteDay: '2026-11-21' }], indexes: [] }).staleTickers).toBe(0);
    expect(staleMarketData({ today: TODAY, tickers: [{ ticker: 'TEST11', lastQuoteDay: '2026-11-20' }], indexes: [] }).staleTickers).toBe(1);
  });

  it('counts each stale ticker once and ignores the fresh ones', () => {
    const r = staleMarketData({
      today: TODAY,
      tickers: [{ ticker: 'TEST11', lastQuoteDay: TODAY }, { ticker: 'ABCD3', lastQuoteDay: null }, { ticker: 'WXYZ11', lastQuoteDay: '2026-10-01' }],
      indexes: [],
    });
    expect(r.staleTickers).toBe(2);
  });

  it(`a daily index (CDI, Selic) in use for a while with no rate for more than ${DAILY_RATE_MAX_AGE_DAYS} days is stale`, () => {
    expect(DAILY_RATE_MAX_AGE_DAYS).toBe(7);
    const fresh = staleMarketData({ today: TODAY, tickers: [], indexes: [{ index: 'CDI', inUseSince: '2026-01-02', lastRateDay: '2026-11-18' }] });
    const stale = staleMarketData({ today: TODAY, tickers: [], indexes: [{ index: 'CDI', inUseSince: '2026-01-02', lastRateDay: '2026-11-17' }] });
    expect(fresh.staleIndexes).toEqual([]);
    expect(stale.staleIndexes).toEqual(['CDI']);
  });

  it('an index that just came into use gets the same grace period (the Banco Central publishes a day later)', () => {
    expect(staleMarketData({ today: TODAY, tickers: [], indexes: [{ index: 'CDI', inUseSince: TODAY, lastRateDay: null }] }).staleIndexes).toEqual([]);
    expect(staleMarketData({ today: TODAY, tickers: [], indexes: [{ index: 'SELIC', inUseSince: '2026-11-10', lastRateDay: null }] }).staleIndexes).toEqual(['SELIC']);
  });

  it(`IPCA is monthly: stale only after ${MONTHLY_RATE_MAX_AGE_DAYS} days without a new month`, () => {
    expect(MONTHLY_RATE_MAX_AGE_DAYS).toBe(75);
    expect(staleMarketData({ today: TODAY, tickers: [], indexes: [{ index: 'IPCA', inUseSince: '2026-01-01', lastRateDay: '2026-09-11' }] }).staleIndexes).toEqual([]);
    expect(staleMarketData({ today: TODAY, tickers: [], indexes: [{ index: 'IPCA', inUseSince: '2026-01-01', lastRateDay: '2026-09-10' }] }).staleIndexes).toEqual(['IPCA']);
  });
});

describe('StaleMarketDataError', () => {
  it('says what is stale with counts and index names only (the workflow log is public: no tickers)', () => {
    const e = new StaleMarketDataError({ staleTickers: 2, staleIndexes: ['CDI'] });
    expect(e.message).toMatch(/2 ticker/);
    expect(e.message).toMatch(/CDI/);
    expect(e.message).not.toMatch(/TEST11|ABCD3/);
  });
});
