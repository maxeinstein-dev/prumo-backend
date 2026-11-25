import type { FastifyInstance } from 'fastify';

/** The database (Neon) sleeps and can take up to about a minute to wake up. */
export const DB_HEALTH_TIMEOUT_MS = 90_000;

/** How long a successful result is reused, so bursts of requests do not each reach the database. */
export const DB_HEALTH_CACHE_MS = 10_000;

interface DbTx {
  $queryRaw: (...args: any[]) => Promise<unknown>;
}
interface DbClient {
  $transaction: (cb: (tx: DbTx) => Promise<unknown>, options?: { maxWait?: number; timeout?: number }) => Promise<unknown>;
}

type Outcome = { ok: true; ms: number } | { ok: false };

/**
 * GET /health/db: one minimal query to the database. Unlike /health (which never touches the database, so a sleeping
 * database cannot fail a deploy), this one is meant for a monitor. The response never carries the database message.
 */
export async function registerDbHealthRoute(
  app: FastifyInstance,
  client: DbClient,
  timeoutMs: number = DB_HEALTH_TIMEOUT_MS,
  cacheMs: number = DB_HEALTH_CACHE_MS
): Promise<void> {
  let inFlight: Promise<Outcome> | null = null;
  let lastOk: { at: number; ms: number } | null = null;

  /**
   * One check at a time per process: callers that arrive while it runs share its result instead of opening more
   * queries. The limit is enforced by the database (SET LOCAL statement_timeout, so the query is cancelled and frees
   * its pool connection); the Node-side race is only a safety net for a connection that never opens.
   */
  const check = (): Promise<Outcome> => {
    if (lastOk && Date.now() - lastOk.at < cacheMs) return Promise.resolve({ ok: true, ms: lastOk.ms });
    if (inFlight) return inFlight;
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const run = Promise.race([
      client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`;
          await tx.$queryRaw`SELECT 1`;
        },
        { maxWait: timeoutMs, timeout: timeoutMs + 5_000 }
      ),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ])
      .then((): Outcome => {
        const ms = Date.now() - started;
        lastOk = { at: Date.now(), ms };
        return { ok: true, ms };
      })
      .catch((error): Outcome => {
        // Only the error name is logged: the message can carry the connection string.
        console.error(`[Health] Database check failed (${error instanceof Error ? error.name : 'unknown'})`);
        return { ok: false };
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
        inFlight = null;
      });
    inFlight = run;
    return run;
  };

  app.get('/health/db', {
    schema: {
      description: 'Database health check: runs SELECT 1 (up to 90 s, the database may be waking up)',
      tags: ['Health'],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            db: { type: 'string', example: 'ok' },
            ms: { type: 'number', description: 'Time the query took, in milliseconds' },
          },
        },
        503: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'error' },
            db: { type: 'string', example: 'unreachable' },
          },
        },
      },
    },
  }, async (_request, reply) => {
    const outcome = await check();
    if (outcome.ok) return reply.code(200).send({ status: 'ok', db: 'ok', ms: outcome.ms });
    return reply.code(503).send({ status: 'error', db: 'unreachable' });
  });
}
