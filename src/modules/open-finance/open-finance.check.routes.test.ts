import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { ensurePersonalHousehold, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { checkOpenFinance } from './open-finance.check.js';
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
vi.mock('./open-finance.preview.js', () => ({ previewOpenFinance: vi.fn() }));
vi.mock('./open-finance.links.js', () => ({}));
vi.mock('./open-finance.check.js', () => ({ checkOpenFinance: vi.fn() }));

const HH = '11111111-1111-4111-8111-111111111111';
const AUTH = { authorization: 'Bearer test' };
const REPORT = { from: '2026-10-27', to: '2026-11-26', items: [], accounts: [], transfers: { matched: 0, missing: [] }, savingsNames: [], cardsNotChecked: 0, investmentsNotChecked: 0 };

const m = {
  member: vi.mocked(requireHouseholdMember),
  personal: vi.mocked(ensurePersonalHousehold),
  check: vi.mocked(checkOpenFinance),
};

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
  m.member.mockResolvedValue({} as never);
  m.personal.mockResolvedValue(HH);
  m.check.mockResolvedValue(REPORT);
});

describe('GET /open-finance/check', () => {
  it('member reads the check; the savings to ignore come from ?ignoreSavings= (comma separated, trimmed)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/open-finance/check?householdId=${HH}&ignoreSavings=${encodeURIComponent(' Cofrinho Pai , Outro ')}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: REPORT });
    expect(m.member).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.check).toHaveBeenCalledWith(expect.objectContaining({ householdId: HH, ignoredSavings: ['Cofrinho Pai', 'Outro'] }));
  });

  it('without ignoreSavings nothing is ignored', async () => {
    await app.inject({ method: 'GET', url: `/open-finance/check?householdId=${HH}`, headers: AUTH });
    expect(m.check).toHaveBeenCalledWith(expect.objectContaining({ ignoredSavings: [] }));
  });

  it('someone outside the household is refused before Pluggy is called', async () => {
    m.member.mockRejectedValue(new ForbiddenError());
    const res = await app.inject({ method: 'GET', url: `/open-finance/check?householdId=${HH}`, headers: AUTH });
    expect(res.statusCode).toBe(403);
    expect(m.check).not.toHaveBeenCalled();
  });

  it('keys refused answer 502 OPEN_FINANCE_AUTH_FAILED', async () => {
    m.check.mockRejectedValue(new PluggyError('auth', 401));
    const res = await app.inject({ method: 'GET', url: `/open-finance/check?householdId=${HH}`, headers: AUTH });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('OPEN_FINANCE_AUTH_FAILED');
  });
});
