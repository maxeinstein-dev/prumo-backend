import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { InsufficientRoleError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { ensurePersonalHousehold, requireEditor } from '../../shared/middleware/authorization.middleware.js';
import { importOpenFinance } from './open-finance.import.js';
import { openFinanceRoutes } from './open-finance.routes.js';

vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  authMiddleware: () => async (request: { headers: Record<string, string | undefined> }) => {
    if (!request.headers.authorization) throw new (await import('../../shared/errors/app-error.js')).UnauthorizedError();
  },
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireHouseholdMember: vi.fn(),
  requireEditor: vi.fn(),
  ensurePersonalHousehold: vi.fn(),
}));
vi.mock('../../shared/db/prisma.js', () => ({ prisma: {} }));
vi.mock('./open-finance.import.js', () => ({ importOpenFinance: vi.fn() }));

const HH = '11111111-1111-4111-8111-111111111111';
const AUTH = { authorization: 'Bearer test' };
const RESULT = { refs: 2, drafts: 1, transferDrafts: 0, yieldDrafts: 0, blocked: [] };

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  await app.register(openFinanceRoutes, { prefix: '/open-finance' });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireEditor).mockResolvedValue({} as never);
  vi.mocked(ensurePersonalHousehold).mockResolvedValue(HH);
  vi.mocked(importOpenFinance).mockResolvedValue(RESULT);
});

describe('POST /open-finance/import', () => {
  it('EDITOR runs the import of the household and gets its summary', async () => {
    const res = await app.inject({ method: 'POST', url: `/open-finance/import?householdId=${HH}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: RESULT });
    expect(requireEditor).toHaveBeenCalledWith(expect.anything(), HH);
    expect(importOpenFinance).toHaveBeenCalledWith(expect.objectContaining({ householdId: HH }));
  });

  it('a viewer cannot run it', async () => {
    vi.mocked(requireEditor).mockRejectedValue(new InsufficientRoleError());
    const res = await app.inject({ method: 'POST', url: `/open-finance/import?householdId=${HH}`, headers: AUTH });
    expect(res.statusCode).toBe(403);
    expect(importOpenFinance).not.toHaveBeenCalled();
  });
});
