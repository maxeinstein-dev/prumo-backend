import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '../../shared/errors/error-handler.js';
import { ForbiddenError, NotFoundError } from '../../shared/errors/app-error.js';
import { requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { investmentRoutes } from './investments.routes.js';
import * as service from './investments.service.js';

vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  authMiddleware: () => async () => undefined,
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireEditor: vi.fn(),
  requireHouseholdMember: vi.fn(),
  ensurePersonalHousehold: vi.fn(),
  getUserByFirebaseUid: vi.fn(),
}));
vi.mock('./investments.service.js', () => ({
  loadAccount: vi.fn(),
  loadPosition: vi.fn(),
  listPositions: vi.fn(),
  createPosition: vi.fn(),
  getPositionDetail: vi.fn(),
  updatePosition: vi.fn(),
  createMovement: vi.fn(),
  deleteMovement: vi.fn(),
}));

// Invented data only.
const ACC = '11111111-1111-4111-8111-111111111111';
const POS = '22222222-2222-4222-8222-222222222222';
const MOV = '33333333-3333-4333-8333-333333333333';
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  app.setErrorHandler(errorHandler);
  await app.register(investmentRoutes, { prefix: '/investments' });
  await app.ready();
});
afterAll(() => app.close());
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(service.loadAccount).mockResolvedValue({ id: ACC, householdId: 'hh-1' } as never);
  vi.mocked(service.loadPosition).mockResolvedValue({ id: POS, householdId: 'hh-1', account: { householdId: 'hh-1' } } as never);
  vi.mocked(service.listPositions).mockResolvedValue({ summary: {}, positions: [] } as never);
  vi.mocked(service.createPosition).mockResolvedValue({ id: POS } as never);
  vi.mocked(service.getPositionDetail).mockResolvedValue({ id: POS, movements: [] } as never);
  vi.mocked(service.updatePosition).mockResolvedValue({ id: POS } as never);
  vi.mocked(service.createMovement).mockResolvedValue({ movement: { id: MOV }, position: { id: POS } } as never);
  vi.mocked(service.deleteMovement).mockResolvedValue({ position: { id: POS } } as never);
});

const stockBody = { kind: 'STOCK_EXCHANGE', ticker: 'test11', name: 'Fundo Exemplo', opening: { date: '2026-01-10', quantity: 10, amount: 1000 } };

describe('reading', () => {
  it('lists the positions of an account for any member, in the household of the account', async () => {
    const res = await app.inject({ method: 'GET', url: `/investments/accounts/${ACC}/positions?includeClosed=true` });
    expect(res.statusCode).toBe(200);
    expect(requireHouseholdMember).toHaveBeenCalledWith(expect.anything(), 'hh-1');
    expect(requireEditor).not.toHaveBeenCalled();
    expect(service.listPositions).toHaveBeenCalledWith(expect.objectContaining({ id: ACC }), { includeClosed: true });
  });
  it('an account of another household is refused before anything is read', async () => {
    vi.mocked(requireHouseholdMember).mockRejectedValueOnce(new ForbiddenError('no'));
    const res = await app.inject({ method: 'GET', url: `/investments/accounts/${ACC}/positions` });
    expect(res.statusCode).toBe(403);
    expect(service.listPositions).not.toHaveBeenCalled();
  });
  it('an unknown account is 404', async () => {
    vi.mocked(service.loadAccount).mockRejectedValueOnce(new NotFoundError('Account'));
    const res = await app.inject({ method: 'GET', url: `/investments/accounts/${ACC}/positions` });
    expect(res.statusCode).toBe(404);
  });
  it('the detail of a position of another household is refused', async () => {
    vi.mocked(requireHouseholdMember).mockRejectedValueOnce(new ForbiddenError('no'));
    const res = await app.inject({ method: 'GET', url: `/investments/positions/${POS}` });
    expect(res.statusCode).toBe(403);
    expect(service.getPositionDetail).not.toHaveBeenCalled();
  });
  it('a malformed id is 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/investments/positions/not-a-uuid' });
    expect(res.statusCode).toBe(400);
  });
});

describe('writing needs the editor role of the household that owns the account or position', () => {
  it.each([
    ['POST', `/investments/accounts/${ACC}/positions`, stockBody],
    ['PATCH', `/investments/positions/${POS}`, { name: 'Outro nome' }],
    ['POST', `/investments/positions/${POS}/movements`, { type: 'INCOME', date: '2026-02-10', amount: 5 }],
    ['DELETE', `/investments/positions/${POS}/movements/${MOV}`, undefined],
  ])('%s %s: a viewer gets 403 and nothing is written', async (method, url, payload) => {
    vi.mocked(requireEditor).mockRejectedValueOnce(new ForbiddenError('no'));
    const res = await app.inject({ method: method as 'POST', url, payload: payload as object });
    expect(res.statusCode).toBe(403);
    expect(service.createPosition).not.toHaveBeenCalled();
    expect(service.updatePosition).not.toHaveBeenCalled();
    expect(service.createMovement).not.toHaveBeenCalled();
    expect(service.deleteMovement).not.toHaveBeenCalled();
  });

  it('creating answers 201 and upper-cases the ticker', async () => {
    const res = await app.inject({ method: 'POST', url: `/investments/accounts/${ACC}/positions`, payload: stockBody });
    expect(res.statusCode).toBe(201);
    expect(requireEditor).toHaveBeenCalledWith(expect.anything(), 'hh-1');
    expect(service.createPosition).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ticker: 'TEST11' }));
  });

  it('a movement answers 201', async () => {
    const res = await app.inject({ method: 'POST', url: `/investments/positions/${POS}/movements`, payload: { type: 'BUY', date: '2026-02-10', quantity: 1, amount: 120 } });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.movement.id).toBe(MOV);
  });
});

describe('validation (strict): nothing reaches the service', () => {
  const post = (payload: unknown) => app.inject({ method: 'POST', url: `/investments/positions/${POS}/movements`, payload: payload as object });
  it.each([
    ['unknown field', { type: 'BUY', date: '2026-02-10', quantity: 1, amount: 120, balance: 5 }],
    ['unknown type', { type: 'DIVIDEND', date: '2026-02-10', amount: 5 }],
    ['null amount', { type: 'INCOME', date: '2026-02-10', amount: null }],
    ['amount with three decimals', { type: 'INCOME', date: '2026-02-10', amount: 1.005 }],
    ['negative amount', { type: 'INCOME', date: '2026-02-10', amount: -1 }],
    ['zero amount', { type: 'INCOME', date: '2026-02-10', amount: 0 }],
    ['quantity with seven decimals', { type: 'BUY', date: '2026-02-10', quantity: 0.0000001, amount: 1 }],
    ['future date', { type: 'INCOME', date: '2999-01-01', amount: 5 }],
    ['impossible date', { type: 'INCOME', date: '2026-02-30', amount: 5 }],
    ['hex string as amount', { type: 'INCOME', date: '2026-02-10', amount: '0x10' }],
  ])('rejects %s', async (_label, payload) => {
    const res = await post(payload);
    expect(res.statusCode).toBe(400);
    expect(service.createMovement).not.toHaveBeenCalled();
  });

  it('a numeric string is accepted as an amount', async () => {
    const res = await post({ type: 'INCOME', date: '2026-02-10', amount: '5.25' });
    expect(res.statusCode).toBe(201);
    expect(service.createMovement).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: 5.25 }));
  });

  it('a position with an unknown indexer or an empty update is 400', async () => {
    const a = await app.inject({ method: 'POST', url: `/investments/accounts/${ACC}/positions`, payload: { kind: 'FIXED_INCOME', name: 'CDB Exemplo', indexer: 'DOLAR', rate: 100 } });
    const b = await app.inject({ method: 'PATCH', url: `/investments/positions/${POS}`, payload: {} });
    expect(a.statusCode).toBe(400);
    expect(b.statusCode).toBe(400);
    expect(service.createPosition).not.toHaveBeenCalled();
    expect(service.updatePosition).not.toHaveBeenCalled();
  });
});
