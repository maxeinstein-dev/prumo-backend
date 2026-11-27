import { describe, expect, it, vi } from 'vitest';

import { createPluggyClient, PluggyError } from './pluggy.client.js';

// Every answer below is invented: no real item, account, transaction or key.
const CLIENT_ID = 'cid-inventado-0001';
const CLIENT_SECRET = 'pluggy_sk_segredo_inventado_que_nunca_pode_aparecer';
const API_KEY = 'jwt.inventado.apikey';
const ITEM = 'aaaaaaaa-0000-4000-8000-000000000001';
const ACC = 'bbbbbbbb-0000-4000-8000-000000000001';

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A fake fetch answering by path; records every call. */
function fakeFetch(routes: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return routes(call);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function authOk(call: Call): Response | null {
  return call.url === 'https://api.pluggy.ai/auth' ? json(200, { apiKey: API_KEY }) : null;
}

const account = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  itemId: ITEM,
  type: 'BANK',
  subtype: 'CHECKING_ACCOUNT',
  name: 'Conta Inventada',
  marketingName: 'Conta Corrente Inventada',
  number: '0001/99999-0',
  balance: 1234.56,
  currencyCode: 'BRL',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

const transaction = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  accountId: ACC,
  description: 'PIX ENVIADO FULANO INVENTADO',
  descriptionRaw: null,
  amount: -42.5,
  date: '2026-11-20T00:00:00.000Z',
  type: 'DEBIT',
  status: 'POSTED',
  currencyCode: 'BRL',
  category: 'Transfer - PIX',
  ...extra,
});

describe('createPluggyClient', () => {
  it('trades the keys for an API key once and sends it as X-API-KEY on every read', async () => {
    const { fn, calls } = fakeFetch((call) => {
      if (authOk(call)) return authOk(call)!;
      if (call.url.startsWith('https://api.pluggy.ai/accounts')) {
        return json(200, { page: 1, total: 1, totalPages: 1, results: [account(ACC)] });
      }
      return json(200, { results: [], next: null });
    });
    const client = createPluggyClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: fn });

    await client.listAccounts(ITEM);
    await client.listAccounts(ITEM);
    await client.listTransactions(ACC, { from: '2026-10-27', to: '2026-11-26' });

    const auth = calls.filter((c) => c.url === 'https://api.pluggy.ai/auth');
    expect(auth).toHaveLength(1);
    expect(auth[0].method).toBe('POST');
    expect(JSON.parse(auth[0].body!)).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    const reads = calls.filter((c) => c.url !== 'https://api.pluggy.ai/auth');
    expect(reads).toHaveLength(3);
    for (const read of reads) {
      expect(read.headers['x-api-key']).toBe(API_KEY);
      expect(read.url).not.toContain(CLIENT_SECRET);
      expect(read.url).not.toContain(API_KEY);
    }
  });

  it('lists the accounts of an item, following page/totalPages, and keeps only the fields the preview needs', async () => {
    const { fn, calls } = fakeFetch((call) => {
      if (authOk(call)) return authOk(call)!;
      const page = new URL(call.url).searchParams.get('page');
      if (page === '1') return json(200, { page: 1, total: 2, totalPages: 2, results: [account(ACC)] });
      return json(200, {
        page: 2,
        total: 2,
        totalPages: 2,
        results: [account('bbbbbbbb-0000-4000-8000-000000000002', { type: 'CREDIT', subtype: 'CREDIT_CARD', number: 'xxxx0000', balance: 300 })],
      });
    });
    const client = createPluggyClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: fn });

    const accounts = await client.listAccounts(ITEM);

    const reads = calls.filter((c) => c.url.startsWith('https://api.pluggy.ai/accounts'));
    expect(reads).toHaveLength(2);
    expect(new URL(reads[0].url).searchParams.get('itemId')).toBe(ITEM);
    expect(accounts).toEqual([
      {
        id: ACC,
        itemId: ITEM,
        type: 'BANK',
        subtype: 'CHECKING_ACCOUNT',
        name: 'Conta Inventada',
        marketingName: 'Conta Corrente Inventada',
        number: '0001/99999-0',
        balance: 1234.56,
        currencyCode: 'BRL',
      },
      {
        id: 'bbbbbbbb-0000-4000-8000-000000000002',
        itemId: ITEM,
        type: 'CREDIT',
        subtype: 'CREDIT_CARD',
        name: 'Conta Inventada',
        marketingName: 'Conta Corrente Inventada',
        number: 'xxxx0000',
        balance: 300,
        currencyCode: 'BRL',
      },
    ]);
  });

  it('lists transactions through /v2/transactions with dateFrom/dateTo and follows the next cursor until null', async () => {
    const { fn, calls } = fakeFetch((call) => {
      if (authOk(call)) return authOk(call)!;
      const after = new URL(call.url).searchParams.get('after');
      if (!after) {
        return json(200, { results: [transaction('t-1')], next: `?accountId=${ACC}&after=cursor%2Binventado` });
      }
      return json(200, {
        results: [transaction('t-2', { amount: 1500, type: 'CREDIT', date: '2026-11-21T00:00:00.000Z', status: 'PENDING' })],
        next: null,
      });
    });
    const client = createPluggyClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: fn });

    const transactions = await client.listTransactions(ACC, { from: '2026-10-27', to: '2026-11-26' });

    const reads = calls.filter((c) => c.url.includes('/v2/transactions'));
    expect(reads).toHaveLength(2);
    const first = new URL(reads[0].url);
    expect(first.pathname).toBe('/v2/transactions');
    expect(first.searchParams.get('accountId')).toBe(ACC);
    expect(first.searchParams.get('dateFrom')).toBe('2026-10-27');
    expect(first.searchParams.get('dateTo')).toBe('2026-11-26');
    expect(new URL(reads[1].url).searchParams.get('after')).toBe('cursor+inventado');
    expect(transactions).toEqual([
      { id: 't-1', accountId: ACC, date: '2026-11-20', description: 'PIX ENVIADO FULANO INVENTADO', amount: -42.5, type: 'DEBIT', status: 'POSTED' },
      { id: 't-2', accountId: ACC, date: '2026-11-21', description: 'PIX ENVIADO FULANO INVENTADO', amount: 1500, type: 'CREDIT', status: 'PENDING' },
    ]);
  });

  it('stops following a cursor that never ends instead of looping forever', async () => {
    const { fn, calls } = fakeFetch((call) => {
      if (authOk(call)) return authOk(call)!;
      return json(200, { results: [transaction(`t-${calls.length}`)], next: `?accountId=${ACC}&after=sempre` });
    });
    const client = createPluggyClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: fn, maxPages: 5 });

    await expect(client.listTransactions(ACC, { from: '2026-10-27', to: '2026-11-26' })).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    expect(calls.filter((c) => c.url.includes('/v2/transactions'))).toHaveLength(5);
  });

  it('without the keys it fails as not configured and calls nothing', async () => {
    const { fn, calls } = fakeFetch(() => json(200, {}));
    const client = createPluggyClient({ clientId: undefined, clientSecret: '  ', fetch: fn });

    await expect(client.listAccounts(ITEM)).rejects.toMatchObject({ kind: 'not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('wrong keys fail as auth, without the secret in the error, and are not retried on the next read', async () => {
    const { fn, calls } = fakeFetch((call) => {
      if (call.url === 'https://api.pluggy.ai/auth') {
        return json(401, { message: `invalid secret ${CLIENT_SECRET}`, codeDescription: 'CLIENT_SECRET_EXPIRED' });
      }
      return json(200, { results: [] });
    });
    const client = createPluggyClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: fn });

    const error = await client.listAccounts(ITEM).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PluggyError);
    expect(error).toMatchObject({ kind: 'auth', status: 401 });
    expect(JSON.stringify(error)).not.toContain(CLIENT_SECRET);
    expect(String((error as Error).message)).not.toContain(CLIENT_SECRET);

    await expect(client.listAccounts(ITEM)).rejects.toMatchObject({ kind: 'auth' });
    expect(calls.filter((c) => c.url === 'https://api.pluggy.ai/auth')).toHaveLength(1);
  });

  it('an HTTP error on a read fails as http with the status only', async () => {
    const { fn } = fakeFetch((call) => authOk(call) ?? json(500, { message: 'boom' }));
    const client = createPluggyClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: fn });

    await expect(client.listAccounts(ITEM)).rejects.toMatchObject({ kind: 'http', status: 500 });
  });

  it('checkCredentials answers ok when the keys are accepted and refused when Pluggy turns them down', async () => {
    const ok = fakeFetch((call) => authOk(call) ?? json(404, {}));
    await expect(createPluggyClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: ok.fn }).checkCredentials()).resolves.toBe('ok');
    expect(ok.calls).toHaveLength(1);

    const refused = fakeFetch(() => json(401, { codeDescription: 'CLIENT_SECRET_EXPIRED' }));
    await expect(createPluggyClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: refused.fn }).checkCredentials()).resolves.toBe('refused');

    const down = fakeFetch(() => json(503, {}));
    await expect(createPluggyClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: down.fn }).checkCredentials()).rejects.toMatchObject({ kind: 'http', status: 503 });
  });

  it('getItem reads the status of a connection (GET /items/:id) with the consent end, if any', async () => {
    const { fn, calls } = fakeFetch((call) => {
      if (authOk(call)) return authOk(call)!;
      return json(200, {
        id: ITEM,
        status: 'LOGIN_ERROR',
        executionStatus: 'USER_AUTHORIZATION_EXPIRED',
        consentExpiresAt: '2027-11-26T00:00:00.000Z',
        connector: { id: 200, name: 'Banco Inventado' },
      });
    });
    const client = createPluggyClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: fn });

    await expect(client.getItem(ITEM)).resolves.toEqual({
      id: ITEM,
      status: 'LOGIN_ERROR',
      executionStatus: 'USER_AUTHORIZATION_EXPIRED',
      consentExpiresAt: '2027-11-26T00:00:00.000Z',
      connectorName: 'Banco Inventado',
    });
    expect(new URL(calls[1].url).pathname).toBe(`/items/${ITEM}`);
  });

  it('a network failure fails as network', async () => {
    const fn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const client = createPluggyClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: fn });

    await expect(client.listAccounts(ITEM)).rejects.toMatchObject({ kind: 'network' });
  });
});
