import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { InsufficientRoleError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { ensurePersonalHousehold, requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import * as links from './open-finance.links.js';
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
vi.mock('./open-finance.links.js', () => ({
  listLinks: vi.fn(),
  replaceAccountLinks: vi.fn(),
  addItem: vi.fn(),
  replaceItem: vi.fn(),
  removeItem: vi.fn(),
}));

const HH = '11111111-1111-4111-8111-111111111111';
const ITEM = 'aaaaaaaa-0000-4000-8000-00000000000a';
const ITEM_NEW = 'aaaaaaaa-0000-4000-8000-0000000000ff';
const PACC = 'bbbbbbbb-0000-4000-8000-000000000001';
const ACC = 'cccccccc-0000-4000-8000-000000000001';
const AUTH = { authorization: 'Bearer test' };

const m = {
  member: vi.mocked(requireHouseholdMember),
  editor: vi.mocked(requireEditor),
  personal: vi.mocked(ensurePersonalHousehold),
  list: vi.mocked(links.listLinks),
  replace: vi.mocked(links.replaceAccountLinks),
  add: vi.mocked(links.addItem),
  replaceItem: vi.mocked(links.replaceItem),
  remove: vi.mocked(links.removeItem),
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
  m.editor.mockResolvedValue({} as never);
  m.personal.mockResolvedValue(HH);
  m.list.mockResolvedValue({ items: [] });
});

describe('GET /open-finance/links', () => {
  it('member of the household reads the Pluggy accounts with their links', async () => {
    const res = await app.inject({ method: 'GET', url: `/open-finance/links?householdId=${HH}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { items: [] } });
    expect(m.member).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.list).toHaveBeenCalledWith(expect.objectContaining({ householdId: HH }));
  });

  it('keys refused answer 502 OPEN_FINANCE_AUTH_FAILED', async () => {
    m.list.mockRejectedValue(new PluggyError('auth', 401));
    const res = await app.inject({ method: 'GET', url: `/open-finance/links?householdId=${HH}`, headers: AUTH });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('OPEN_FINANCE_AUTH_FAILED');
  });

  it('requires login', async () => {
    const res = await app.inject({ method: 'GET', url: `/open-finance/links?householdId=${HH}` });
    expect(res.statusCode).toBe(401);
  });
});

describe('PUT /open-finance/links', () => {
  it('EDITOR replaces the account links', async () => {
    const body = { links: [{ pluggyItemId: ITEM, pluggyAccountId: PACC, accountId: ACC }] };
    const res = await app.inject({ method: 'PUT', url: `/open-finance/links?householdId=${HH}`, headers: AUTH, payload: body });
    expect(res.statusCode).toBe(200);
    expect(m.editor).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.replace).toHaveBeenCalledWith(expect.objectContaining({ householdId: HH, links: body.links }));
  });

  it('a viewer is refused before anything is written', async () => {
    m.editor.mockRejectedValue(new InsufficientRoleError());
    const res = await app.inject({ method: 'PUT', url: `/open-finance/links?householdId=${HH}`, headers: AUTH, payload: { links: [] } });
    expect(res.statusCode).toBe(403);
    expect(m.replace).not.toHaveBeenCalled();
  });

  it('rejects ids that are not uuids', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/open-finance/links?householdId=${HH}`,
      headers: AUTH,
      payload: { links: [{ pluggyItemId: 'x', pluggyAccountId: PACC, accountId: ACC }] },
    });
    expect(res.statusCode).toBe(400);
    expect(m.replace).not.toHaveBeenCalled();
  });
});

describe('items', () => {
  it('POST /open-finance/items registers an item (EDITOR, 201)', async () => {
    const res = await app.inject({ method: 'POST', url: `/open-finance/items?householdId=${HH}`, headers: AUTH, payload: { itemId: ITEM } });
    expect(res.statusCode).toBe(201);
    expect(m.editor).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.add).toHaveBeenCalledWith(expect.objectContaining({ householdId: HH, itemId: ITEM }));
  });

  it('POST rejects an item id that is not a uuid', async () => {
    const res = await app.inject({ method: 'POST', url: `/open-finance/items?householdId=${HH}`, headers: AUTH, payload: { itemId: 'abc' } });
    expect(res.statusCode).toBe(400);
    expect(m.add).not.toHaveBeenCalled();
  });

  it('PUT /open-finance/items/:itemId moves the item to a new id (EDITOR)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/open-finance/items/${ITEM}?householdId=${HH}`,
      headers: AUTH,
      payload: { newItemId: ITEM_NEW },
    });
    expect(res.statusCode).toBe(200);
    expect(m.replaceItem).toHaveBeenCalledWith(expect.objectContaining({ householdId: HH, itemId: ITEM, newItemId: ITEM_NEW }));
  });

  it('DELETE /open-finance/items/:itemId removes the item (EDITOR)', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/open-finance/items/${ITEM}?householdId=${HH}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(m.editor).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.remove).toHaveBeenCalledWith(expect.objectContaining({ householdId: HH, itemId: ITEM }));
  });
});
