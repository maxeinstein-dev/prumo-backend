import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import { requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import {
  accountParamsSchema,
  createMovementSchema,
  createPositionSchema,
  listPositionsQuerySchema,
  movementParamsSchema,
  positionParamsSchema,
  updatePositionSchema,
} from './investments.schema.js';
import * as service from './investments.service.js';

const dataObject = {
  type: 'object',
  properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true } },
};
const tags = ['Investments'];
const security = [{ bearerAuth: [] }];

/**
 * Investment positions and their movements (P21 L1). Every route finds the account or position first, authorizes against
 * the household that owns it (member to read, EDITOR+ to write) and only then reads or writes. No route creates a
 * Transaction or changes an account balance.
 *
 * No `type` on body fields in the JSON schemas on purpose: Ajv would coerce null/false to 0 before zod runs.
 */
export async function investmentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware());

  /** GET /investments/accounts/:accountId/positions?includeClosed=true */
  app.get('/accounts/:accountId/positions', {
    schema: { description: 'Positions of an investment account with quantity, average price, cost and income, plus the cash at the broker and the total at cost', tags, security, response: { 200: dataObject } },
  }, async (request, reply) => {
    const { accountId } = accountParamsSchema.parse(request.params);
    const query = listPositionsQuerySchema.parse(request.query ?? {});
    const account = await service.loadAccount(accountId);
    await requireHouseholdMember(request, account.householdId);
    return reply.send({ success: true, data: await service.listPositions(account, { includeClosed: query.includeClosed }) });
  });

  /** POST /investments/accounts/:accountId/positions (EDITOR+) */
  app.post('/accounts/:accountId/positions', {
    schema: { description: 'Create a position in an investment account; the initial load is an OPENING movement (EDITOR+)', tags, security, response: { 201: dataObject } },
  }, async (request, reply) => {
    const { accountId } = accountParamsSchema.parse(request.params);
    const input = createPositionSchema.parse(request.body ?? {});
    const account = await service.loadAccount(accountId);
    await requireEditor(request, account.householdId);
    return reply.status(201).send({ success: true, data: await service.createPosition(account, input) });
  });

  /** GET /investments/positions/:positionId */
  app.get('/positions/:positionId', {
    schema: { description: 'A position with its movements (newest first)', tags, security, response: { 200: dataObject } },
  }, async (request, reply) => {
    const { positionId } = positionParamsSchema.parse(request.params);
    const position = await service.loadPosition(positionId);
    await requireHouseholdMember(request, position.householdId);
    return reply.send({ success: true, data: await service.getPositionDetail(position) });
  });

  /** PATCH /investments/positions/:positionId (EDITOR+) */
  app.patch('/positions/:positionId', {
    schema: { description: 'Edit a position: name, goal, indexer/rate/maturity, manual anchor, close or reopen (EDITOR+)', tags, security, response: { 200: dataObject } },
  }, async (request, reply) => {
    const { positionId } = positionParamsSchema.parse(request.params);
    const input = updatePositionSchema.parse(request.body ?? {});
    const position = await service.loadPosition(positionId);
    await requireEditor(request, position.householdId);
    return reply.send({ success: true, data: await service.updatePosition(position, input) });
  });

  /** POST /investments/positions/:positionId/movements (EDITOR+) */
  app.post('/positions/:positionId/movements', {
    schema: { description: 'Register a movement (OPENING, BUY, SELL, INCOME). Creates no transaction and does not change the account balance (EDITOR+)', tags, security, response: { 201: dataObject } },
  }, async (request, reply) => {
    const { positionId } = positionParamsSchema.parse(request.params);
    const input = createMovementSchema.parse(request.body ?? {});
    const position = await service.loadPosition(positionId);
    await requireEditor(request, position.householdId);
    return reply.status(201).send({ success: true, data: await service.createMovement(position, input) });
  });

  /** DELETE /investments/positions/:positionId/movements/:movementId (EDITOR+) */
  app.delete('/positions/:positionId/movements/:movementId', {
    schema: { description: 'Delete a movement; refused when a later sale would be left without its holding (EDITOR+)', tags, security, response: { 200: dataObject } },
  }, async (request, reply) => {
    const { positionId, movementId } = movementParamsSchema.parse(request.params);
    const position = await service.loadPosition(positionId);
    await requireEditor(request, position.householdId);
    return reply.send({ success: true, data: await service.deleteMovement(position, movementId) });
  });
}
