import { describe, expect, it, vi } from 'vitest';
import { createBcbClient } from './bcb.client.js';
import { createBrapiClient } from './brapi.client.js';

// Invented tokens, tickers and recorded answers in the real shape of each service.
const TOKEN = 'tok-invented-123456';
const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const asFetch = (f: unknown) => f as unknown as typeof fetch;

describe('brapi client', () => {
  const answer = {
    results: [
      { symbol: 'TEST11', regularMarketPrice: 10.25, regularMarketTime: '2026-11-25T20:07:49.000Z', currency: 'BRL' },
      { symbol: 'ABCD3', regularMarketPrice: 33.1, regularMarketTime: 1795636800, currency: 'BRL' }, // unix seconds
    ],
  };

  it('asks for all the tickers in ONE call, sends the token only in the Authorization header', async () => {
    const fetchFn = vi.fn(async () => json(answer));
    const client = createBrapiClient({ token: TOKEN, fetch: asFetch(fetchFn), today: () => '2026-11-26' });
    const r = await client.fetchQuotes(['test11', 'ABCD3']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://brapi.dev/api/quote/TEST11,ABCD3');
    expect(url).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(r.warnings).toEqual([]);
    expect(r.quotes).toEqual([
      { ticker: 'TEST11', date: '2026-11-25', close: 10.25 },
      { ticker: 'ABCD3', date: '2026-11-25', close: 33.1 },
    ]);
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

  it('a network error becomes a warning and never leaks the token (even if the error message has it)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error(`connect ECONNRESET Authorization: Bearer ${TOKEN}`);
    });
    const r = await createBrapiClient({ token: TOKEN, fetch: asFetch(fetchFn) }).fetchQuotes(['TEST11']);
    expect(r.quotes).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('a timeout becomes a warning (the request is aborted)', async () => {
    const fetchFn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(new Error('aborted')));
        }),
    );
    const r = await createBrapiClient({ token: TOKEN, fetch: asFetch(fetchFn), timeoutMs: 20 }).fetchQuotes(['TEST11']);
    expect(r.quotes).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/timeout/i);
  });

  it('an HTTP error becomes a warning with the status only', async () => {
    const r = await createBrapiClient({ token: TOKEN, fetch: asFetch(async () => json({ message: `bad ${TOKEN}` }, 401)) }).fetchQuotes(['TEST11']);
    expect(r.quotes).toEqual([]);
    expect(r.warnings.join(' ')).toContain('401');
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('keeps the good tickers and warns about the bad ones (zero, text, unknown ticker)', async () => {
    const body = {
      results: [
        { symbol: 'TEST11', regularMarketPrice: 10.25, regularMarketTime: '2026-11-25T20:00:00.000Z' },
        { symbol: 'ABCD3', regularMarketPrice: 0 },
        { symbol: 'ZZZZ3', regularMarketPrice: 'oops' },
      ],
    };
    const r = await createBrapiClient({ token: TOKEN, fetch: asFetch(async () => json(body)), today: () => '2026-11-26' }).fetchQuotes(['TEST11', 'ABCD3', 'ZZZZ3', 'NOPE4']);
    expect(r.quotes.map((q) => q.ticker)).toEqual(['TEST11']);
    expect(r.warnings.join(' ')).toMatch(/ABCD3/);
    expect(r.warnings.join(' ')).toMatch(/ZZZZ3/);
    expect(r.warnings.join(' ')).toMatch(/NOPE4/);
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

  it('a body that is not the expected shape is a warning', async () => {
    const r = await createBrapiClient({ token: TOKEN, fetch: asFetch(async () => json('<html>')) }).fetchQuotes(['TEST11']);
    expect(r.quotes).toEqual([]);
    expect(r.warnings).toHaveLength(1);
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
