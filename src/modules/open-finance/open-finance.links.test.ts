import { describe, expect, it, vi } from 'vitest';

import {
  addItem,
  listLinks,
  removeItem,
  replaceAccountLinks,
  replaceItem,
  type LinksDb,
} from './open-finance.links.js';
import { PluggyError, type PluggyAccount, type PluggyClient } from './pluggy.client.js';

// Invented ids only.
const HH = '11111111-1111-4111-8111-111111111111';
const ITEM_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const ITEM_B = 'aaaaaaaa-0000-4000-8000-00000000000b';
const ITEM_NEW = 'aaaaaaaa-0000-4000-8000-0000000000ff';
const P_CHECK = 'bbbbbbbb-0000-4000-8000-000000000001';
const P_CARD = 'bbbbbbbb-0000-4000-8000-000000000002';
const P_OTHER = 'bbbbbbbb-0000-4000-8000-000000000003';
const ACC_BANK = 'cccccccc-0000-4000-8000-000000000001';
const ACC_CARD = 'cccccccc-0000-4000-8000-000000000002';

type Row = { id: string; householdId: string; pluggyItemId: string; pluggyAccountId: string | null; accountId: string | null; lastSyncAt?: Date | null; lastError?: string | null };

/** An in-memory open_finance_links table plus the household's active accounts. */
function fakeDb(rows: Row[], accounts: Array<{ id: string; type: string }> = [{ id: ACC_BANK, type: 'CHECKING' }, { id: ACC_CARD, type: 'CREDIT_CARD' }]) {
  let table = rows.map((r) => ({ ...r }));
  let seq = 0;
  const match = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'not' in (v as object)) return (r as never)[k] !== (v as { not: unknown }).not;
      return (r as never)[k] === v;
    });
  const db = {
    openFinanceLink: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => table.filter((r) => match(r, where))),
      create: vi.fn(async ({ data }: { data: Omit<Row, 'id'> }) => {
        const row = { pluggyAccountId: null, accountId: null, id: `row-${++seq}`, ...(data as Partial<Row>) } as Row;
        table.push(row);
        return row;
      }),
      createMany: vi.fn(async ({ data }: { data: Array<Omit<Row, 'id'>> }) => {
        for (const d of data) table.push({ id: `row-${++seq}`, ...d } as Row);
        return { count: data.length };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        let count = 0;
        table = table.map((r) => (match(r, where) ? (count++, { ...r, ...data }) : r));
        return { count };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const before = table.length;
        table = table.filter((r) => !match(r, where));
        return { count: before - table.length };
      }),
    },
    account: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; householdId: string } }) =>
        where.householdId === HH ? accounts.filter((a) => where.id.in.includes(a.id)) : [],
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { db: db as unknown as LinksDb, raw: db, table: () => table };
}

const pAcc = (id: string, itemId: string, type: 'BANK' | 'CREDIT'): PluggyAccount => ({
  id,
  itemId,
  type,
  subtype: type === 'BANK' ? 'CHECKING_ACCOUNT' : 'CREDIT_CARD',
  name: type === 'BANK' ? 'Conta Inventada' : 'Cartão Inventado',
  marketingName: null,
  number: '0000',
  balance: 0,
  currencyCode: 'BRL',
});

function client(byItem: Record<string, PluggyAccount[] | Error>): PluggyClient {
  return {
    checkCredentials: vi.fn(async () => 'ok' as const),
    getItem: vi.fn(async (id: string) => ({ id, status: 'UPDATED', executionStatus: 'SUCCESS', consentExpiresAt: null, connectorName: null })),
    listAccounts: vi.fn(async (itemId: string) => {
      const answer = byItem[itemId];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    }),
    listTransactions: vi.fn(async () => []),
  };
}

const row = (id: string, pluggyItemId: string, pluggyAccountId: string | null = null, accountId: string | null = null): Row => ({
  id,
  householdId: HH,
  pluggyItemId,
  pluggyAccountId,
  accountId,
});

describe('listLinks', () => {
  it('shows every Pluggy account of each registered item with its Prumo account, without reading transactions', async () => {
    const { db } = fakeDb([row('r1', ITEM_A), row('r2', ITEM_A, P_CARD, ACC_CARD), row('r3', ITEM_B)]);
    const c = client({ [ITEM_A]: [pAcc(P_CHECK, ITEM_A, 'BANK'), pAcc(P_CARD, ITEM_A, 'CREDIT')], [ITEM_B]: [] });

    const result = await listLinks({ householdId: HH, db, client: c });

    expect(c.listTransactions).not.toHaveBeenCalled();
    expect(result).toEqual({
      items: [
        {
          itemId: ITEM_A,
          error: null,
          accounts: [
            { ...pAcc(P_CHECK, ITEM_A, 'BANK'), accountId: null },
            { ...pAcc(P_CARD, ITEM_A, 'CREDIT'), accountId: ACC_CARD },
          ],
          orphanLinks: [],
          lastSyncAt: null,
          lastError: null,
        },
        { itemId: ITEM_B, error: null, accounts: [], orphanLinks: [], lastSyncAt: null, lastError: null },
      ],
    });
  });

  it('a link to a Pluggy account that no longer exists (e.g. after renewing the item) comes back as orphan', async () => {
    const { db } = fakeDb([row('r1', ITEM_A, P_OTHER, ACC_BANK)]);
    const result = await listLinks({ householdId: HH, db, client: client({ [ITEM_A]: [pAcc(P_CHECK, ITEM_A, 'BANK')] }) });

    expect(result.items[0].orphanLinks).toEqual([{ pluggyAccountId: P_OTHER, accountId: ACC_BANK }]);
    expect(result.items[0].accounts[0].accountId).toBeNull();
  });

  it('an item Pluggy cannot read shows its error and keeps its saved links as they are', async () => {
    const { db } = fakeDb([row('r1', ITEM_A, P_CHECK, ACC_BANK)]);
    const result = await listLinks({ householdId: HH, db, client: client({ [ITEM_A]: new PluggyError('http', 400) }) });

    expect(result.items[0]).toEqual({
      itemId: ITEM_A,
      error: 'Pluggy answered with an error (HTTP 400)',
      accounts: [],
      orphanLinks: [{ pluggyAccountId: P_CHECK, accountId: ACC_BANK }],
      lastSyncAt: null,
      lastError: null,
    });
  });

  it('keys missing or refused fail the whole listing', async () => {
    const { db } = fakeDb([row('r1', ITEM_A)]);
    await expect(
      listLinks({ householdId: HH, db, client: client({ [ITEM_A]: new PluggyError('auth', 401) }) }),
    ).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('replaceAccountLinks', () => {
  it('replaces every account link of the household at once and keeps the item rows', async () => {
    const { db, table, raw } = fakeDb([row('r1', ITEM_A), row('r2', ITEM_A, P_OTHER, ACC_BANK)]);

    await replaceAccountLinks({
      householdId: HH,
      db,
      links: [
        { pluggyItemId: ITEM_A, pluggyAccountId: P_CHECK, accountId: ACC_BANK },
        { pluggyItemId: ITEM_A, pluggyAccountId: P_CARD, accountId: ACC_CARD },
      ],
    });

    expect(raw.$transaction).toHaveBeenCalledTimes(1);
    expect(table().map((r) => [r.pluggyItemId, r.pluggyAccountId, r.accountId])).toEqual([
      [ITEM_A, null, null],
      [ITEM_A, P_CHECK, ACC_BANK],
      [ITEM_A, P_CARD, ACC_CARD],
    ]);
  });

  it('an empty list unlinks everything (the Pluggy accounts are then ignored) but keeps the items', async () => {
    const { db, table } = fakeDb([row('r1', ITEM_A), row('r2', ITEM_A, P_CHECK, ACC_BANK)]);
    await replaceAccountLinks({ householdId: HH, db, links: [] });
    expect(table()).toHaveLength(1);
    expect(table()[0].pluggyAccountId).toBeNull();
  });

  it('refuses an item that is not registered in the household (404), changing nothing', async () => {
    const { db, table } = fakeDb([row('r1', ITEM_A, P_CHECK, ACC_BANK)]);
    await expect(
      replaceAccountLinks({ householdId: HH, db, links: [{ pluggyItemId: ITEM_B, pluggyAccountId: P_CARD, accountId: ACC_CARD }] }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(table()[0].accountId).toBe(ACC_BANK);
  });

  it('refuses a Prumo account that is not an active account of the household (404)', async () => {
    const { db } = fakeDb([row('r1', ITEM_A)]);
    await expect(
      replaceAccountLinks({
        householdId: HH,
        db,
        links: [{ pluggyItemId: ITEM_A, pluggyAccountId: P_CHECK, accountId: 'dddddddd-0000-4000-8000-000000000009' }],
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses the same Pluggy account twice, or two Pluggy accounts feeding the same Prumo account (400)', async () => {
    const { db } = fakeDb([row('r1', ITEM_A)]);
    await expect(
      replaceAccountLinks({
        householdId: HH,
        db,
        links: [
          { pluggyItemId: ITEM_A, pluggyAccountId: P_CHECK, accountId: ACC_BANK },
          { pluggyItemId: ITEM_A, pluggyAccountId: P_CHECK, accountId: ACC_CARD },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      replaceAccountLinks({
        householdId: HH,
        db,
        links: [
          { pluggyItemId: ITEM_A, pluggyAccountId: P_CHECK, accountId: ACC_BANK },
          { pluggyItemId: ITEM_A, pluggyAccountId: P_CARD, accountId: ACC_BANK },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('items', () => {
  it('addItem registers an item id once; the same id again is a 409', async () => {
    const { db, table } = fakeDb([]);
    await addItem({ householdId: HH, db, itemId: ITEM_A });
    expect(table()).toEqual([expect.objectContaining({ householdId: HH, pluggyItemId: ITEM_A, pluggyAccountId: null, accountId: null })]);
    await expect(addItem({ householdId: HH, db, itemId: ITEM_A })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('replaceItem moves every row of the item to the new id (renewed authorization) and keeps the account links', async () => {
    const { db, table } = fakeDb([row('r1', ITEM_A), row('r2', ITEM_A, P_CHECK, ACC_BANK), row('r3', ITEM_B)]);
    await replaceItem({ householdId: HH, db, itemId: ITEM_A, newItemId: ITEM_NEW });
    expect(table().map((r) => r.pluggyItemId)).toEqual([ITEM_NEW, ITEM_NEW, ITEM_B]);
    expect(table()[1].accountId).toBe(ACC_BANK);
  });

  it('replaceItem: unknown item is a 404; a new id already registered is a 409', async () => {
    const { db } = fakeDb([row('r1', ITEM_A), row('r2', ITEM_B)]);
    await expect(replaceItem({ householdId: HH, db, itemId: ITEM_NEW, newItemId: 'aaaaaaaa-0000-4000-8000-0000000000ee' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(replaceItem({ householdId: HH, db, itemId: ITEM_A, newItemId: ITEM_B })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('removeItem deletes the item and its account links; unknown item is a 404', async () => {
    const { db, table } = fakeDb([row('r1', ITEM_A), row('r2', ITEM_A, P_CHECK, ACC_BANK), row('r3', ITEM_B)]);
    await removeItem({ householdId: HH, db, itemId: ITEM_A });
    expect(table().map((r) => r.pluggyItemId)).toEqual([ITEM_B]);
    await expect(removeItem({ householdId: HH, db, itemId: ITEM_A })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('listLinks: sync state (P25 L2c)', () => {
  it('each item says when it was last imported and the last error, if any', async () => {
    const synced = new Date('2026-11-28T11:00:00.000Z');
    const { db } = fakeDb([
      { ...row('r1', ITEM_A, P_CHECK, ACC_BANK), lastSyncAt: synced, lastError: null } as Row,
      { ...row('r2', ITEM_B, P_OTHER, ACC_CARD), lastSyncAt: null, lastError: 'A autorização deste banco venceu: reconecte no Meu Pluggy.' } as Row,
    ]);
    const result = await listLinks({ householdId: HH, db, client: client({ [ITEM_A]: [pAcc(P_CHECK, ITEM_A, 'BANK')], [ITEM_B]: [] }) });
    expect(result.items.map((i) => [i.itemId, i.lastSyncAt, i.lastError])).toEqual([
      [ITEM_A, synced.toISOString(), null],
      [ITEM_B, null, 'A autorização deste banco venceu: reconecte no Meu Pluggy.'],
    ]);
  });
});
