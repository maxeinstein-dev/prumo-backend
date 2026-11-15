import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { ensurePersonalHousehold, requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { dashboardRoutes } from './dashboard.routes.js';
import { loadPurchaseSimulation } from './purchase-simulation.loader.js';

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
vi.mock('./purchase-simulation.loader.js', () => ({ loadPurchaseSimulation: vi.fn() }));
vi.mock('./income-split.loader.js', () => ({ loadIncomeSplit: vi.fn() }));
vi.mock('./month-close.js', () => ({ loadMonthClose: vi.fn(), saveMonthClosing: vi.fn() }));
vi.mock('./cash-flow.loader.js', () => ({ loadCashFlow: vi.fn() }));
vi.mock('./net-worth.loader.js', () => ({ loadNetWorth: vi.fn() }));
vi.mock('./dashboard.service.js', () => ({}));

const HH = '11111111-1111-4111-8111-111111111111';
const CARD = '22222222-2222-4222-8222-222222222222';
const AUTH = { authorization: 'Bearer test' };
const m = { member: vi.mocked(requireHouseholdMember), editor: vi.mocked(requireEditor), personal: vi.mocked(ensurePersonalHousehold), load: vi.mocked(loadPurchaseSimulation) };
const sample = { firstMonth: '2026-12', months: [], installments: [100], hasExpectedIncome: false, tightest: null, budgetOverruns: [], averageExpense: { months: 6, amount: 0 } };

describe('POST /dashboard/purchase-simulation', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(dashboardRoutes, { prefix: '/dashboard' });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    m.member.mockResolvedValue({} as never);
    m.personal.mockResolvedValue(HH);
    m.load.mockResolvedValue(sample as never);
  });
  const post = (body: unknown, headers: Record<string, string> = AUTH) => app.inject({ method: 'POST', url: '/dashboard/purchase-simulation', headers, payload: body as object });

  it('answers 401 without credentials', async () => {
    expect((await post({ totalAmount: 1200, installments: 12 }, {})).statusCode).toBe(401);
    expect(m.load).not.toHaveBeenCalled();
  });

  it('checks the membership only (a viewer may simulate: nothing is saved) and returns the simulation in the envelope', async () => {
    const res = await post({ householdId: HH, totalAmount: 1200, installments: 12, accountId: CARD, categoryName: 'ELECTRONICS', firstMonth: '2026-12' });
    expect(res.statusCode).toBe(200);
    expect(m.member).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.editor).not.toHaveBeenCalled();
    expect(m.load).toHaveBeenCalledWith({ householdId: HH, totalAmount: 1200, installments: 12, accountId: CARD, categoryName: 'ELECTRONICS', firstMonth: '2026-12' });
    expect(res.json()).toEqual({ success: true, data: sample });
  });

  it('falls back to the personal household', async () => {
    await post({ totalAmount: 1200, installments: 12 });
    expect(m.load).toHaveBeenCalledWith(expect.objectContaining({ householdId: HH }));
  });

  it('refuses what is not a purchase in 1 to 24 installments of whole cents', async () => {
    for (const body of [
      {},
      { totalAmount: 0, installments: 3 },
      { totalAmount: -50, installments: 3 },
      { totalAmount: 100.123, installments: 3 },
      { totalAmount: 100, installments: 0 },
      { totalAmount: 100, installments: 25 },
      { totalAmount: 100, installments: 2.5 },
      { totalAmount: 0.05, installments: 6 }, // a part would be zero
      { totalAmount: 100, installments: 3, firstMonth: '2026-13' },
      { totalAmount: 100, installments: 3, accountId: 'not-a-uuid' },
    ]) {
      expect((await post(body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(m.load).not.toHaveBeenCalled();
  });

  it('loads nothing for someone outside the household', async () => {
    m.member.mockRejectedValue(new ForbiddenError('no'));
    expect((await post({ householdId: HH, totalAmount: 1200, installments: 12 })).statusCode).toBe(403);
    expect(m.load).not.toHaveBeenCalled();
  });
});
