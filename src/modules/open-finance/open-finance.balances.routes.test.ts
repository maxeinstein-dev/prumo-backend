import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { ensurePersonalHousehold, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { balanceChecks } from './open-finance.balances.js';
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
vi.mock('./open-finance.balances.js', () => ({ balanceChecks: vi.fn() }));

const HH = '11111111-1111-4111-8111-111111111111';
const AUTH = { authorization: 'Bearer test' };

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
  vi.mocked(requireHouseholdMember).mockResolvedValue({} as never);
  vi.mocked(ensurePersonalHousehold).mockResolvedValue(HH);
  vi.mocked(balanceChecks).mockResolvedValue([]);
});

describe('GET /open-finance/balances', () => {
  it('member reads the balance check of the household', async () => {
    const res = await app.inject({ method: 'GET', url: `/open-finance/balances?householdId=${HH}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { balances: [] } });
    expect(requireHouseholdMember).toHaveBeenCalledWith(expect.anything(), HH);
    expect(balanceChecks).toHaveBeenCalledWith(expect.objectContaining({ householdId: HH }));
  });

  it('someone outside the household is refused', async () => {
    vi.mocked(requireHouseholdMember).mockRejectedValue(new ForbiddenError());
    const res = await app.inject({ method: 'GET', url: `/open-finance/balances?householdId=${HH}`, headers: AUTH });
    expect(res.statusCode).toBe(403);
    expect(balanceChecks).not.toHaveBeenCalled();
  });
});
