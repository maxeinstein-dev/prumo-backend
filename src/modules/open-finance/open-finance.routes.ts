import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../../shared/db/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import { ensurePersonalHousehold, requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { addItem, listLinks, removeItem, replaceAccountLinks, replaceItem, type LinksDb } from './open-finance.links.js';
import { previewOpenFinance, type PreviewDb } from './open-finance.preview.js';
import { createPluggyClient, PluggyError } from './pluggy.client.js';

const previewQuerySchema = z.object({ householdId: z.string().uuid().optional() });
const householdQuerySchema = previewQuerySchema;
const replaceLinksSchema = z.object({
  links: z
    .array(z.object({ pluggyItemId: z.string().uuid(), pluggyAccountId: z.string().uuid(), accountId: z.string().uuid() }))
    .max(50),
});
const addItemSchema = z.object({ itemId: z.string().uuid() });
const itemParamsSchema = z.object({ itemId: z.string().uuid() });
const replaceItemSchema = z.object({ newItemId: z.string().uuid() });

const objectResponse = {
  200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true } } },
} as const;

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

function clientFromEnv() {
  // One client per request: the keys are traded for an API key once, here.
  return createPluggyClient({ clientId: process.env.PLUGGY_CLIENT_ID, clientSecret: process.env.PLUGGY_CLIENT_SECRET });
}

async function withPluggyErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PluggyError) throw toAppError(error);
    throw error;
  }
}

export async function openFinanceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware());
  const db = prisma as unknown as LinksDb;

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

  /**
   * GET /open-finance/links
   * The Pluggy accounts of every registered item (no transactions) with the Prumo account each one feeds.
   */
  app.get('/links', {
    schema: {
      description: 'Open Finance links: the Pluggy accounts of each registered item and the Prumo account each one feeds (null = ignored); saved links whose Pluggy account is not listed come as orphanLinks',
      tags: ['Open Finance'],
      security: [{ bearerAuth: [] }],
      response: objectResponse,
    },
  }, async (request, reply) => {
    const query = householdQuerySchema.parse(request.query);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);
    const data = await withPluggyErrors(() => listLinks({ householdId, db, client: clientFromEnv() }));
    return reply.send({ success: true, data });
  });

  /**
   * PUT /open-finance/links
   * Replace every account link of the household at once (EDITOR+). A Pluggy account left out is ignored.
   */
  app.put('/links', {
    schema: {
      description: 'Replace all account links of the household (EDITOR+). Unknown item or account is a 404; the same Pluggy account twice, or two Pluggy accounts on one Prumo account, is a 400',
      tags: ['Open Finance'],
      security: [{ bearerAuth: [] }],
      response: objectResponse,
    },
  }, async (request, reply) => {
    const query = householdQuerySchema.parse(request.query);
    const body = replaceLinksSchema.parse(request.body);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    await replaceAccountLinks({ householdId, db, links: body.links });
    return reply.send({ success: true, data: { links: body.links } });
  });

  /** POST /open-finance/items : register an item id copied from the Meu Pluggy dashboard (EDITOR+). */
  app.post('/items', {
    schema: {
      description: 'Register a Meu Pluggy item id in the household (EDITOR+); already registered is a 409',
      tags: ['Open Finance'],
      security: [{ bearerAuth: [] }],
      response: { 201: objectResponse[200] },
    },
  }, async (request, reply) => {
    const query = householdQuerySchema.parse(request.query);
    const body = addItemSchema.parse(request.body);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    await addItem({ householdId, db, itemId: body.itemId });
    return reply.status(201).send({ success: true, data: { itemId: body.itemId } });
  });

  /** PUT /open-finance/items/:itemId : the item got a new id (renewed authorization); links are kept (EDITOR+). */
  app.put('/items/:itemId', {
    schema: {
      description: 'Move an item to a new id after the authorization was renewed, keeping its account links (EDITOR+)',
      tags: ['Open Finance'],
      security: [{ bearerAuth: [] }],
      response: objectResponse,
    },
  }, async (request, reply) => {
    const query = householdQuerySchema.parse(request.query);
    const { itemId } = itemParamsSchema.parse(request.params);
    const body = replaceItemSchema.parse(request.body);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    await replaceItem({ householdId, db, itemId, newItemId: body.newItemId });
    return reply.send({ success: true, data: { itemId: body.newItemId } });
  });

  /** DELETE /open-finance/items/:itemId : stop reading an item, with its account links (EDITOR+). */
  app.delete('/items/:itemId', {
    schema: {
      description: 'Remove an item and its account links from the household (EDITOR+)',
      tags: ['Open Finance'],
      security: [{ bearerAuth: [] }],
      response: objectResponse,
    },
  }, async (request, reply) => {
    const query = householdQuerySchema.parse(request.query);
    const { itemId } = itemParamsSchema.parse(request.params);
    const householdId = query.householdId ?? await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);
    await removeItem({ householdId, db, itemId });
    return reply.send({ success: true, data: { itemId } });
  });
}
