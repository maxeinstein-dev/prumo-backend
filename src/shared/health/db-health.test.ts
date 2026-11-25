import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DB_HEALTH_TIMEOUT_MS, registerDbHealthRoute } from './db-health.js';

type Query = (...args: unknown[]) => Promise<unknown>;
/** Fake client: $transaction runs the callback with a tx whose $queryRaw is the given query (set_config calls are recorded). */
const fakeClient = (query: Query, setups: unknown[][] = []) => ({
  $transaction: async (cb: (tx: any) => Promise<unknown>) =>
    cb({
      $queryRaw: (...args: unknown[]) => {
        const text = (args[0] as string[]).join('?');
        if (text.includes('set_config')) { setups.push(args); return Promise.resolve([]); }
        return query(...args);
      },
    }),
});
const build = async (query: Query, timeoutMs?: number, cacheMs = 0, setups?: unknown[][]) => {
  const app = Fastify();
  await registerDbHealthRoute(app, fakeClient(query, setups), timeoutMs, cacheMs);
  return app;
};

afterEach(() => vi.restoreAllMocks());

describe('GET /health/db', () => {
  it('has a 90 s limit', () => {
    expect(DB_HEALTH_TIMEOUT_MS).toBe(90_000);
  });

  it('answers 200 with the elapsed time when the database answers', async () => {
    const query = vi.fn(async () => [{ '?column?': 1 }]);
    const app = await build(query);
    const res = await app.inject({ method: 'GET', url: '/health/db' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: 'ok' });
    expect(typeof res.json().ms).toBe('number');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('answers 503 without the database message when the query fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = await build(async () => { throw new Error('connect ECONNREFUSED postgres://user:secret@db.example:5432'); });
    const res = await app.inject({ method: 'GET', url: '/health/db' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', db: 'unreachable' });
    expect(res.body).not.toContain('secret');
  });

  it('answers 503 when the database does not answer within the limit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = await build(() => new Promise(() => undefined), 20);
    const res = await app.inject({ method: 'GET', url: '/health/db' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', db: 'unreachable' });
  });

  it('runs ONE query for many simultaneous calls and gives them all the same answer (single flight)', async () => {
    let release: () => void = () => undefined;
    const query = vi.fn(() => new Promise((resolve) => { release = () => resolve([{ '?column?': 1 }]); }));
    const app = await build(query);
    const calls = Array.from({ length: 5 }, () => app.inject({ method: 'GET', url: '/health/db' }));
    await new Promise((r) => setTimeout(r, 20));
    release();
    const results = await Promise.all(calls);
    expect(query).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(results.map((r) => r.body)).size).toBe(1);
  });

  it('shares a failure too, and runs a new query once the previous one is done', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const query = vi.fn(async () => { await new Promise((r) => setTimeout(r, 10)); throw new Error('down'); });
    const app = await build(query);
    const first = await Promise.all([1, 2, 3].map(() => app.inject({ method: 'GET', url: '/health/db' })));
    expect(first.map((r) => r.statusCode)).toEqual([503, 503, 503]);
    expect(query).toHaveBeenCalledTimes(1);
    await app.inject({ method: 'GET', url: '/health/db' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('reuses a recent OK result for the cache window, then queries again', async () => {
    const query = vi.fn(async () => [{ '?column?': 1 }]);
    const app = await build(query, undefined, 40);
    await app.inject({ method: 'GET', url: '/health/db' });
    await app.inject({ method: 'GET', url: '/health/db' });
    expect(query).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 60));
    await app.inject({ method: 'GET', url: '/health/db' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const query = vi.fn(async () => { throw new Error('down'); });
    const app = await build(query, undefined, 10_000);
    await app.inject({ method: 'GET', url: '/health/db' });
    await app.inject({ method: 'GET', url: '/health/db' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('sets a statement_timeout of the same limit inside the transaction, before SELECT 1', async () => {
    const setups: unknown[][] = [];
    const query = vi.fn(async () => []);
    const app = await build(query, 1234, 0, setups);
    await app.inject({ method: 'GET', url: '/health/db' });
    expect(setups).toHaveLength(1);
    expect((setups[0]![0] as string[]).join('?')).toContain('statement_timeout');
    expect(setups[0]!.slice(1)).toContain('1234');
  });

  it('is limited by the global rate limit when registered after it', async () => {
    const app = Fastify();
    await app.register(rateLimit, { max: 2, timeWindow: 60000 });
    await registerDbHealthRoute(app, fakeClient(async () => []), undefined, 0);
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await app.inject({ method: 'GET', url: '/health/db' })).statusCode);
    expect(codes).toEqual([200, 200, 429]);
  });
});

describe('app.ts wiring', () => {
  const source = readFileSync(new URL('../../app.ts', import.meta.url), 'utf8');

  it('registers /health/db after the rate limit plugin (routes added earlier are not limited)', () => {
    const rate = source.indexOf('app.register(rateLimit');
    const db = source.indexOf('registerDbHealthRoute(app');
    expect(rate).toBeGreaterThan(-1);
    expect(db).toBeGreaterThan(rate);
  });

  it('keeps /health free of the database', () => {
    const start = source.indexOf("app.get('/health'");
    const end = source.indexOf("Health check endpoint registered");
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, end)).not.toMatch(/prisma|\$queryRaw/);
  });
});
