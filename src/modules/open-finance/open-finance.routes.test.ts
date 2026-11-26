import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { ensurePersonalHousehold, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { previewOpenFinance } from './open-finance.preview.js';
import { openFinanceRoutes } from './open-finance.routes.js';
import { createPluggyClient, PluggyError } from './pluggy.client.js';

vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  authMiddleware: () => async (request: { headers: Record<string, string | undefined> }) => {
    if (!request.headers.authorization) throw new (await import('../../shared/errors/app-error.js')).UnauthorizedError();
  },
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireHouseholdMember: vi.fn(),
  ensurePersonalHousehold: vi.fn(),
}));
vi.mock('../../shared/db/prisma.js', () => ({ prisma: { openFinanceLink: { findMany: vi.fn() } } }));
vi.mock('./open-finance.preview.js', () => ({ previewOpenFinance: vi.fn() }));
vi.mock('./pluggy.client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./pluggy.client.js')>();
  return { ...real, createPluggyClient: vi.fn(() => ({ listAccounts: vi.fn(), listTransactions: vi.fn() })) };
});

const HH = '11111111-1111-4111-8111-111111111111';
const PERSONAL_HH = '22222222-2222-4222-8222-222222222222';
const AUTH = { authorization: 'Bearer test' };
const SECRET = 'pluggy_sk_segredo_inventado_da_rota';

const m = {
  member: vi.mocked(requireHouseholdMember),
  personal: vi.mocked(ensurePersonalHousehold),
  preview: vi.mocked(previewOpenFinance),
  client: vi.mocked(createPluggyClient),
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
  m.personal.mockResolvedValue(PERSONAL_HH);
  m.preview.mockResolvedValue({ from: '2026-10-27', to: '2026-11-26', items: [] });
  vi.stubEnv('PLUGGY_CLIENT_ID', 'cid-inventado');
  vi.stubEnv('PLUGGY_CLIENT_SECRET', SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /open-finance/preview', () => {
  it('requires login', async () => {
    const res = await app.inject({ method: 'GET', url: `/open-finance/preview?householdId=${HH}` });
    expect(res.statusCode).toBe(401);
    expect(m.preview).not.toHaveBeenCalled();
  });

  it('checks membership of the household and answers the preview, with one Pluggy client built from the environment', async () => {
    const res = await app.inject({ method: 'GET', url: `/open-finance/preview?householdId=${HH}`, headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { from: '2026-10-27', to: '2026-11-26', items: [] } });
    expect(m.member).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.client).toHaveBeenCalledTimes(1);
    expect(m.client).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'cid-inventado', clientSecret: SECRET }));
    expect(m.preview).toHaveBeenCalledWith(expect.objectContaining({ householdId: HH }));
  });

  it('without householdId uses the personal household', async () => {
    const res = await app.inject({ method: 'GET', url: '/open-finance/preview', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(m.member).toHaveBeenCalledWith(expect.anything(), PERSONAL_HH);
    expect(m.preview).toHaveBeenCalledWith(expect.objectContaining({ householdId: PERSONAL_HH }));
  });

  it('a household of someone else is refused before calling Pluggy', async () => {
    m.member.mockRejectedValue(new ForbiddenError());

    const res = await app.inject({ method: 'GET', url: `/open-finance/preview?householdId=${HH}`, headers: AUTH });

    expect(res.statusCode).toBe(403);
    expect(m.preview).not.toHaveBeenCalled();
  });

  it('rejects a householdId that is not a uuid', async () => {
    const res = await app.inject({ method: 'GET', url: '/open-finance/preview?householdId=nope', headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(m.preview).not.toHaveBeenCalled();
  });

  it('keys not configured answer 503 OPEN_FINANCE_NOT_CONFIGURED', async () => {
    m.preview.mockRejectedValue(new PluggyError('not_configured'));

    const res = await app.inject({ method: 'GET', url: `/open-finance/preview?householdId=${HH}`, headers: AUTH });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('OPEN_FINANCE_NOT_CONFIGURED');
  });

  it('keys refused answer 502 OPEN_FINANCE_AUTH_FAILED and never echo the secret', async () => {
    m.preview.mockRejectedValue(new PluggyError('auth', 401));

    const res = await app.inject({ method: 'GET', url: `/open-finance/preview?householdId=${HH}`, headers: AUTH });

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('OPEN_FINANCE_AUTH_FAILED');
    expect(res.body).not.toContain(SECRET);
  });

  it('Pluggy down answers 502 OPEN_FINANCE_UNAVAILABLE', async () => {
    m.preview.mockRejectedValue(new PluggyError('network'));

    const res = await app.inject({ method: 'GET', url: `/open-finance/preview?householdId=${HH}`, headers: AUTH });

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('OPEN_FINANCE_UNAVAILABLE');
  });
});
