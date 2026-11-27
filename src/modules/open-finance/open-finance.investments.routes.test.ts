import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { ensurePersonalHousehold, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { checkInvestments } from './open-finance.investments.js';
import { openFinanceRoutes } from './open-finance.routes.js';
import { PluggyError } from './pluggy.client.js';

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
vi.mock('../investments/investments.service.js', () => ({ listPositions: vi.fn(), loadAccount: vi.fn() }));
vi.mock('./open-finance.investments.js', () => ({ checkInvestments: vi.fn() }));

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
  vi.mocked(checkInvestments).mockResolvedValue([]);
});

describe('GET /open-finance/investments', () => {
  it('member reads the investments check of the household', async () => {
    const res = await app.inject({ method: 'GET', url: `/open-finance/investments?householdId=${HH}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { accounts: [] } });
    expect(requireHouseholdMember).toHaveBeenCalledWith(expect.anything(), HH);
    expect(checkInvestments).toHaveBeenCalledWith(expect.objectContaining({ householdId: HH, loadPortfolio: expect.any(Function) }));
  });

  it('refused keys answer 502, a stranger 403', async () => {
    vi.mocked(checkInvestments).mockRejectedValueOnce(new PluggyError('auth', 401));
    const refused = await app.inject({ method: 'GET', url: `/open-finance/investments?householdId=${HH}`, headers: AUTH });
    expect(refused.statusCode).toBe(502);
    vi.mocked(requireHouseholdMember).mockRejectedValueOnce(new ForbiddenError());
    const stranger = await app.inject({ method: 'GET', url: `/open-finance/investments?householdId=${HH}`, headers: AUTH });
    expect(stranger.statusCode).toBe(403);
  });
});
