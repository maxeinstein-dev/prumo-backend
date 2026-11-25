import { describe, expect, it, vi } from 'vitest';
import { createBcbClient } from './bcb.client.js';
import { createBrapiClient } from './brapi.client.js';

// Invented tokens, tickers and recorded answers in the real shape of each service.
const TOKEN = 'tok-invented-123456';
const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const asFetch = (f: unknown) => f as unknown as typeof fetch;

describe('brapi client (one request per ticker, like the Rende)', () => {
  const one = (symbol: string, price: unknown, time: unknown = '2026-11-25T20:07:49.000Z') =>
    json({ results: [{ symbol, regularMarketPrice: price, regularMarketTime: time, currency: 'BRL' }] });
  /** Answers by the ticker in the URL. */
  const byTicker = (table: Record<string, () => Response | Promise<Response>>) =>
    vi.fn(async (url: string) => table[url.split('/').pop()!]!());

  it('makes ONE request per ticker (never several in one URL), the token only in the Authorization header', async () => {
    const fetchFn = byTicker({
      TEST11: () => one('TEST11', 10.25),
      ABCD3: () => one('ABCD3', 33.1, 1795636800), // unix seconds
    });
    const r = await createBrapiClient({ token: TOKEN, fetch: asFetch(fetchFn), today: () => '2026-11-26' }).fetchQuotes(['test11', 'ABCD3']);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const calls = fetchFn.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map((c) => c[0]).sort()).toEqual(['https://brapi.dev/api/quote/ABCD3', 'https://brapi.dev/api/quote/TEST11']);
    for (const [url, init] of calls) {
      expect(url).not.toContain(TOKEN);
      expect(url).not.toContain(',');
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    }
    expect(r.warnings).toEqual([]);
    expect(r.quotes).toEqual([
      { ticker: 'TEST11', date: '2026-11-25', close: 10.25 },
      { ticker: 'ABCD3', date: '2026-11-25', close: 33.1 },
    ]);
  });

  it('a ticker repeated in the list is asked once', async () => {
    const fetchFn = byTicker({ TEST11: () => one('TEST11', 10) });
    await createBrapiClient({ token: TOKEN, fetch: asFetch(fetchFn) }).fetchQuotes(['TEST11', 'test11']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('the failure of one ticker is a warning about that ticker only; the others are kept', async () => {
    const fetchFn = byTicker({
      TEST11: () => one('TEST11', 10.25),
      ABCD3: () => json({ message: `bad ${TOKEN}` }, 404),
      ZZZZ3: () => {
        throw new Error(`connect ECONNRESET Bearer ${TOKEN}`);
      },
      NOPE4: () => json({ results: [] }),
      ZERO3: () => one('ZERO3', 0),
      TEXT3: () => one('TEXT3', 'oops'),
    });
    const r = await createBrapiClient({ token: TOKEN, fetch: asFetch(fetchFn), today: () => '2026-11-26' }).fetchQuotes(['TEST11', 'ABCD3', 'ZZZZ3', 'NOPE4', 'ZERO3', 'TEXT3']);
    expect(r.quotes.map((q) => q.ticker)).toEqual(['TEST11']);
    expect(r.warnings).toHaveLength(5);
    for (const t of ['ABCD3', 'ZZZZ3', 'NOPE4', 'ZERO3', 'TEXT3']) expect(r.warnings.filter((w) => w.includes(t))).toHaveLength(1);
    expect(r.warnings.find((w) => w.includes('ABCD3'))).toContain('404');
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('never has more than 3 requests in flight at the same time, and still asks them all', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchFn = vi.fn(async (url: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 15));
      inFlight -= 1;
      const t = url.split('/').pop()!;
      return one(t, 5);
    });
    const tickers = ['AAAA3', 'BBBB3', 'CCCC3', 'DDDD3', 'EEEE3', 'FFFF3', 'GGGG3'];
    const r = await createBrapiClient({ token: TOKEN, fetch: asFetch(fetchFn), today: () => '2026-11-26' }).fetchQuotes(tickers);
    expect(fetchFn).toHaveBeenCalledTimes(7);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(r.quotes.map((q) => q.ticker)).toEqual(tickers); // the order of the request is kept
  });

  it('without a token it makes no call and warns', async () => {
    const fetchFn = vi.fn();
    const r = await createBrapiClient({ token: undefined, fetch: asFetch(fetchFn) }).fetchQuotes(['TEST11']);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(r.quotes).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/BRAPI_TOKEN/);
  });

  it('a blank token counts as no token', async () => {
    const fetchFn = vi.fn();
    const r = await createBrapiClient({ token: '   ', fetch: asFetch(fetchFn) }).fetchQuotes(['TEST11']);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(r.warnings).toHaveLength(1);
  });

  it('no tickers: no call, no warning', async () => {
    const fetchFn = vi.fn();
    const r = await createBrapiClient({ token: TOKEN, fetch: asFetch(fetchFn) }).fetchQuotes([]);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(r).toEqual({ quotes: [], warnings: [] });
  });

  it('a timeout is per call: the slow ticker becomes its own warning and the fast one is kept', async () => {
    const fetchFn = vi.fn((url: string, init: RequestInit) => {
      if (url.endsWith('/TEST11')) return Promise.resolve(one('TEST11', 10.25));
      return new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      });
    });
    const r = await createBrapiClient({ token: TOKEN, fetch: asFetch(fetchFn), timeoutMs: 20, today: () => '2026-11-26' }).fetchQuotes(['TEST11', 'SLOW3']);
    expect(r.quotes.map((q) => q.ticker)).toEqual(['TEST11']);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/timeout.*SLOW3/i);
  });

  it('a close without a time takes the day of the run', async () => {
    const r = await createBrapiClient({
      token: TOKEN,
      fetch: asFetch(async () => json({ results: [{ symbol: 'TEST11', regularMarketPrice: 9.9 }] })),
      today: () => '2026-11-26',
    }).fetchQuotes(['TEST11']);
    expect(r.quotes).toEqual([{ ticker: 'TEST11', date: '2026-11-26', close: 9.9 }]);
  });

  it('rejects a malformed ticker without calling (never builds a URL from it)', async () => {
    const fetchFn = vi.fn();
    const r = await createBrapiClient({ token: TOKEN, fetch: asFetch(fetchFn) }).fetchQuotes(['../x?token=1']);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(r.warnings).toHaveLength(1);
  });

  it('a body that is not the expected shape is a warning for that ticker', async () => {
    const r = await createBrapiClient({ token: TOKEN, fetch: asFetch(async () => json('<html>')) }).fetchQuotes(['TEST11']);
    expect(r.quotes).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('TEST11');
  });
});

describe('Banco Central (SGS) client', () => {
  it('asks the right series and period, and reads the recorded daily CDI (percent a day)', async () => {
    const fetchFn = vi.fn(async () => json([{ data: '02/11/2026', valor: '0.054266' }, { data: '03/11/2026', valor: '0.054266' }]));
    const r = await createBcbClient({ fetch: asFetch(fetchFn) }).fetchSeries('CDI', '2026-11-02', '2026-11-25');
    expect((fetchFn.mock.calls[0] as unknown[])[0]).toBe(
      'https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados?formato=json&dataInicial=02/11/2026&dataFinal=25/11/2026',
    );
    expect(r.rates).toEqual([
      { date: '2026-11-02', value: 0.054266 },
      { date: '2026-11-03', value: 0.054266 },
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('Selic is series 11 and IPCA is 433', async () => {
    const fetchFn = vi.fn(async () => json([]));
    const c = createBcbClient({ fetch: asFetch(fetchFn) });
    await c.fetchSeries('SELIC', '2026-11-02', '2026-11-25');
    await c.fetchSeries('IPCA', '2026-01-01', '2026-11-25');
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toContain('bcdata.sgs.11/');
    expect(String((fetchFn.mock.calls[1] as unknown[])[0])).toContain('bcdata.sgs.433/');
  });

  it('the monthly IPCA is dated on the 1st of the reference month, a negative month is kept', async () => {
    const r = await createBcbClient({
      fetch: asFetch(async () => json([{ data: '01/09/2026', valor: '-0.02' }, { data: '01/10/2026', valor: '0.44' }])),
    }).fetchSeries('IPCA', '2026-09-01', '2026-11-25');
    expect(r.rates).toEqual([
      { date: '2026-09-01', value: -0.02 },
      { date: '2026-10-01', value: 0.44 },
    ]);
  });

  it('an empty answer is not an error (nothing published in the period)', async () => {
    const r = await createBcbClient({ fetch: asFetch(async () => json([])) }).fetchSeries('CDI', '2026-11-25', '2026-11-25');
    expect(r).toEqual({ rates: [], warnings: [] });
  });

  it('network error, timeout and HTTP error become warnings, with no rates', async () => {
    const boom = await createBcbClient({
      fetch: asFetch(async () => {
        throw new Error('ECONNRESET');
      }),
    }).fetchSeries('CDI', '2026-11-02', '2026-11-25');
    expect(boom.rates).toEqual([]);
    expect(boom.warnings).toHaveLength(1);
    const http = await createBcbClient({ fetch: asFetch(async () => json({}, 503)) }).fetchSeries('CDI', '2026-11-02', '2026-11-25');
    expect(http.warnings.join(' ')).toContain('503');
    const slow = await createBcbClient({
      fetch: asFetch((_u: string, init: RequestInit) => new Promise<Response>((_a, rej) => init.signal?.addEventListener('abort', () => rej(new Error('x'))))),
      timeoutMs: 20,
    }).fetchSeries('CDI', '2026-11-02', '2026-11-25');
    expect(slow.rates).toEqual([]);
    expect(slow.warnings).toHaveLength(1);
  });

  it('skips malformed rows and warns once (bad date, text value)', async () => {
    const r = await createBcbClient({
      fetch: asFetch(async () => json([{ data: '2026-11-02', valor: '0.05' }, { data: '03/11/2026', valor: 'abc' }, { data: '04/11/2026', valor: '0.05' }])),
    }).fetchSeries('CDI', '2026-11-02', '2026-11-25');
    expect(r.rates).toEqual([{ date: '2026-11-04', value: 0.05 }]);
    expect(r.warnings).toHaveLength(1);
  });

  it('an answer that is not a list is a warning', async () => {
    const r = await createBcbClient({ fetch: asFetch(async () => json({ error: 'x' })) }).fetchSeries('CDI', '2026-11-02', '2026-11-25');
    expect(r.rates).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });
});
