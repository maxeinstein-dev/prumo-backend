import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { ensurePersonalHousehold, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { calculateCreditCardInvoice } from '../transactions/credit-card-invoice.service.js';
import { checkCards } from './open-finance.cards.js';
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
vi.mock('../investments/investments.service.js', () => ({ listPositions: vi.fn(), loadAccount: vi.fn() }));
vi.mock('../transactions/credit-card-invoice.service.js', () => ({ calculateCreditCardInvoice: vi.fn() }));
vi.mock('./open-finance.cards.js', () => ({ checkCards: vi.fn() }));

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
  vi.mocked(checkCards).mockResolvedValue([]);
});

describe('GET /open-finance/cards', () => {
  it('member reads the card check; each Prumo invoice comes from the same calculation as the Cartões page', async () => {
    const res = await app.inject({ method: 'GET', url: `/open-finance/cards?householdId=${HH}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { cards: [] } });
    expect(requireHouseholdMember).toHaveBeenCalledWith(expect.anything(), HH);

    const { loadInvoice } = vi.mocked(checkCards).mock.calls[0][0];
    vi.mocked(calculateCreditCardInvoice).mockResolvedValue({ data: { statementTotal: 1212.56, dueDate: '2026-11-08', closingDate: '2026-11-01', state: 'paid' }, pagination: {} } as never);
    await expect(loadInvoice('acc-card', '2026-11')).resolves.toEqual({ dueDate: '2026-11-08', statementTotal: 1212.56, state: 'paid' });
    expect(calculateCreditCardInvoice).toHaveBeenCalledWith('acc-card', '2026-11', HH, expect.anything());
  });

  it('a stranger is refused', async () => {
    vi.mocked(requireHouseholdMember).mockRejectedValueOnce(new ForbiddenError());
    const res = await app.inject({ method: 'GET', url: `/open-finance/cards?householdId=${HH}`, headers: AUTH });
    expect(res.statusCode).toBe(403);
    expect(checkCards).not.toHaveBeenCalled();
  });
});
