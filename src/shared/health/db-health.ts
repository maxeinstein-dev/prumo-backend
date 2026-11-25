import type { FastifyInstance } from 'fastify';

/** The database (Neon) sleeps and can take up to about a minute to wake up. */
export const DB_HEALTH_TIMEOUT_MS = 90_000;

interface DbClient {
  $queryRaw: (...args: any[]) => Promise<unknown>;
}

/**
 * GET /health/db: one minimal query to the database. Unlike /health (which never touches the database, so a sleeping
 * database cannot fail a deploy), this one is meant for a monitor. The response never carries the database message.
 */
export async function registerDbHealthRoute(
  app: FastifyInstance,
  client: DbClient,
  timeoutMs: number = DB_HEALTH_TIMEOUT_MS
): Promise<void> {
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
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.$queryRaw`SELECT 1`,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
      return reply.code(200).send({ status: 'ok', db: 'ok', ms: Date.now() - started });
    } catch (error) {
      // Only the error name is logged: the message can carry the connection string.
      console.error(`[Health] Database check failed (${error instanceof Error ? error.name : 'unknown'})`);
      return reply.code(503).send({ status: 'error', db: 'unreachable' });
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}
