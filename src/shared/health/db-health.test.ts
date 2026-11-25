import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DB_HEALTH_TIMEOUT_MS, registerDbHealthRoute } from './db-health.js';

const build = async (client: { $queryRaw: (...args: unknown[]) => Promise<unknown> }, timeoutMs?: number) => {
  const app = Fastify();
  await registerDbHealthRoute(app, client, timeoutMs);
  return app;
};

afterEach(() => vi.restoreAllMocks());

describe('GET /health/db', () => {
  it('has a 90 s limit', () => {
    expect(DB_HEALTH_TIMEOUT_MS).toBe(90_000);
  });

  it('answers 200 with the elapsed time when the database answers', async () => {
    const query = vi.fn(async () => [{ '?column?': 1 }]);
    const app = await build({ $queryRaw: query });
    const res = await app.inject({ method: 'GET', url: '/health/db' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: 'ok' });
    expect(typeof res.json().ms).toBe('number');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('answers 503 without the database message when the query fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = await build({ $queryRaw: async () => { throw new Error('connect ECONNREFUSED postgres://user:secret@db.example:5432'); } });
    const res = await app.inject({ method: 'GET', url: '/health/db' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', db: 'unreachable' });
    expect(res.body).not.toContain('secret');
  });

  it('answers 503 when the database does not answer within the limit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = await build({ $queryRaw: () => new Promise(() => undefined) }, 20);
    const res = await app.inject({ method: 'GET', url: '/health/db' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', db: 'unreachable' });
  });

  it('is limited by the global rate limit when registered after it', async () => {
    const app = Fastify();
    await app.register(rateLimit, { max: 2, timeWindow: 60000 });
    await registerDbHealthRoute(app, { $queryRaw: async () => [] });
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
