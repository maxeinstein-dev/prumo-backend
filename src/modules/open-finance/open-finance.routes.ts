import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../../shared/db/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import { ensurePersonalHousehold, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { previewOpenFinance, type PreviewDb } from './open-finance.preview.js';
import { createPluggyClient, PluggyError } from './pluggy.client.js';

const previewQuerySchema = z.object({ householdId: z.string().uuid().optional() });

/** Pluggy failures as API errors with fixed texts (never the keys, never Pluggy's own message). */
function toAppError(error: PluggyError): AppError {
  switch (error.kind) {
    case 'not_configured':
      return new AppError('Open Finance is not configured on this server', 503, 'OPEN_FINANCE_NOT_CONFIGURED');
    case 'auth':
      return new AppError('Pluggy refused the server credentials', 502, 'OPEN_FINANCE_AUTH_FAILED');
    default:
      return new AppError(error.message, 502, 'OPEN_FINANCE_UNAVAILABLE');
  }
}

export async function openFinanceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware());

  /**
   * GET /open-finance/preview
   * What Pluggy shows for the items linked to the household: accounts and the last 30 days of transactions.
   * Reads only; nothing is written (importing is P25 L2).
   */
  app.get('/preview', {
    schema: {
      description: 'Preview of the linked Open Finance (Meu Pluggy) items: accounts and last 30 days of transactions. Writes nothing.',
      tags: ['Open Finance'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true } },
        },
      },
    },
  }, async (request, reply) => {
    const query = previewQuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);

    // One client per request: the keys are traded for an API key once, here.
    const client = createPluggyClient({
      clientId: process.env.PLUGGY_CLIENT_ID,
      clientSecret: process.env.PLUGGY_CLIENT_SECRET,
    });

    try {
      const data = await previewOpenFinance({ householdId, db: prisma as unknown as PreviewDb, client });
      return reply.send({ success: true, data });
    } catch (error) {
      if (error instanceof PluggyError) throw toAppError(error);
      throw error;
    }
  });
}
