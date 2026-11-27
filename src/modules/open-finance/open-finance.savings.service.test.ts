import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { InsufficientRoleError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { ensurePersonalHousehold, requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { listSavings, replaceSavings, type SavingsDb } from './open-finance.savings.service.js';

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
vi.mock('../../shared/db/prisma.js', () => ({ prisma: { $transaction: vi.fn() } }));

// Invented names and values only.
const HH = '11111111-1111-4111-8111-111111111111';

function fakeDb(rows: Array<Record<string, unknown>> = []) {
  let table = rows.map((r) => ({ ...r }));
  const db = {
    openFinanceSavings: {
      findMany: vi.fn(async () => table),
      deleteMany: vi.fn(async () => {
        const count = table.length;
        table = [];
        return { count };
      }),
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        table.push(...data);
        return { count: data.length };
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { db: db as unknown as SavingsDb, raw: db, table: () => table };
}

describe('savings service', () => {
  it('listSavings maps the rows to the config the classifier uses (cents and YYYY-MM-DD)', async () => {
    const { db } = fakeDb([
      { name: 'Cofrinho Azul', aliases: ['Reserva Antiga'], inPrumo: true, approxBalance: '400.00', balanceAsOf: new Date('2026-11-20T00:00:00Z') },
      { name: 'Cofrinho Pai', aliases: [], inPrumo: false, approxBalance: null, balanceAsOf: null },
    ]);
    expect(await listSavings(db, HH)).toEqual([
      { name: 'Cofrinho Azul', aliases: ['Reserva Antiga'], inPrumo: true, approxCents: 40000, asOf: '2026-11-20' },
      { name: 'Cofrinho Pai', aliases: [], inPrumo: false, approxCents: null, asOf: null },
    ]);
  });

  it('replaceSavings replaces the whole list in one transaction', async () => {
    const { db, raw, table } = fakeDb([{ name: 'Velho', aliases: [], inPrumo: true, approxBalance: null, balanceAsOf: null }]);
    await replaceSavings(db, HH, [
      { name: ' Cofrinho Azul ', aliases: ['Reserva Antiga', ''], inPrumo: true, approxBalance: 400, balanceAsOf: '2026-11-20' },
    ]);
    expect(raw.$transaction).toHaveBeenCalledTimes(1);
    expect(table()).toEqual([
      { householdId: HH, name: 'Cofrinho Azul', aliases: ['Reserva Antiga'], inPrumo: true, approxBalance: 400, balanceAsOf: new Date('2026-11-20T00:00:00Z') },
    ]);
  });

  it('refuses the same name twice, also through an alias and ignoring accents and case (400)', async () => {
    const { db } = fakeDb();
    await expect(
      replaceSavings(db, HH, [
        { name: 'Cofrinho Azul', aliases: [], inPrumo: true, approxBalance: null, balanceAsOf: null },
        { name: 'Outro', aliases: ['cofrinho azúl'], inPrumo: false, approxBalance: null, balanceAsOf: null },
      ]),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('routes', () => {
  let app: FastifyInstance;
  const AUTH = { authorization: 'Bearer test' };

  beforeAll(async () => {
    const { openFinanceRoutes } = await import('./open-finance.routes.js');
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(openFinanceRoutes, { prefix: '/open-finance' });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    vi.mocked(requireHouseholdMember).mockReset().mockResolvedValue({} as never);
    vi.mocked(requireEditor).mockReset().mockResolvedValue({} as never);
    vi.mocked(ensurePersonalHousehold).mockReset().mockResolvedValue(HH);
  });

  it('PUT /open-finance/savings needs EDITOR and refuses a balance without its day (400)', async () => {
    vi.mocked(requireEditor).mockRejectedValueOnce(new InsufficientRoleError());
    const denied = await app.inject({ method: 'PUT', url: `/open-finance/savings?householdId=${HH}`, headers: AUTH, payload: { savings: [] } });
    expect(denied.statusCode).toBe(403);

    const bad = await app.inject({
      method: 'PUT',
      url: `/open-finance/savings?householdId=${HH}`,
      headers: AUTH,
      payload: { savings: [{ name: 'Cofrinho Azul', inPrumo: true, approxBalance: 400 }] },
    });
    expect(bad.statusCode).toBe(400);
  });
});
