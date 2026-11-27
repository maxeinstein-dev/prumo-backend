import { describe, expect, it, vi } from 'vitest';

import { previewOpenFinance } from './open-finance.preview.js';
import { PluggyError, type PluggyAccount, type PluggyClient, type PluggyTransaction } from './pluggy.client.js';

// Invented ids and values only.
const HH = '11111111-1111-4111-8111-111111111111';
const ITEM_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const ITEM_B = 'aaaaaaaa-0000-4000-8000-00000000000b';
const PACC_1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const PACC_2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const PACC_3 = 'bbbbbbbb-0000-4000-8000-000000000003';
const PRUMO_ACC = 'cccccccc-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-26T15:00:00.000Z');

const acc = (id: string, itemId: string, name: string): PluggyAccount => ({
  id,
  itemId,
  type: 'BANK',
  subtype: 'CHECKING_ACCOUNT',
  name,
  marketingName: null,
  number: '0001/00000-0',
  balance: 100,
  currencyCode: 'BRL',
});

const tx = (id: string, accountId: string): PluggyTransaction => ({
  id,
  accountId,
  date: '2026-11-20',
  description: 'COMPRA INVENTADA',
  amount: -10,
  type: 'DEBIT',
  status: 'POSTED',
});

/** A db with ONLY a read: any write the preview tried would fail with "not a function". */
function readOnlyDb(links: Array<{ pluggyItemId: string; pluggyAccountId: string | null; accountId: string | null }>) {
  const findMany = vi.fn(async () => links);
  return { db: { openFinanceLink: { findMany } }, findMany };
}

function fakeClient(overrides: Partial<PluggyClient> = {}): PluggyClient {
  return {
    checkCredentials: vi.fn(async () => 'ok' as const),
    getItem: vi.fn(async (id: string) => ({ id, status: 'UPDATED', executionStatus: 'SUCCESS', consentExpiresAt: null, connectorName: null })),
    listAccounts: vi.fn(async (itemId: string) =>
      itemId === ITEM_A ? [acc(PACC_1, ITEM_A, 'Conta A'), acc(PACC_2, ITEM_A, 'Cofrinho A')] : [acc(PACC_3, ITEM_B, 'Conta B')],
    ),
    listInvestments: vi.fn(async () => []),
    listBills: vi.fn(async () => []),
    listCards: vi.fn(async () => []),
    listTransactions: vi.fn(async (accountId: string) => [tx(`t-${accountId.slice(-1)}`, accountId)]),
    ...overrides,
  };
}

describe('previewOpenFinance', () => {
  it('lists the accounts of every linked item with the last 30 days of transactions, and reads only the links of the household', async () => {
    const { db, findMany } = readOnlyDb([
      { pluggyItemId: ITEM_A, pluggyAccountId: PACC_1, accountId: PRUMO_ACC },
      { pluggyItemId: ITEM_A, pluggyAccountId: null, accountId: null },
      { pluggyItemId: ITEM_B, pluggyAccountId: null, accountId: null },
    ]);
    const client = fakeClient();

    const preview = await previewOpenFinance({ householdId: HH, db, client, now: NOW });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { householdId: HH } }));
    expect(preview.from).toBe('2026-10-27');
    expect(preview.to).toBe('2026-11-26');
    // One listing per item even when the item has several links.
    expect(client.listAccounts).toHaveBeenCalledTimes(2);
    expect(client.listTransactions).toHaveBeenCalledWith(PACC_1, { from: '2026-10-27', to: '2026-11-26' });
    expect(preview.items).toEqual([
      {
        itemId: ITEM_A,
        error: null,
        accounts: [
          { ...acc(PACC_1, ITEM_A, 'Conta A'), linkedAccountId: PRUMO_ACC, transactions: [tx('t-1', PACC_1)] },
          { ...acc(PACC_2, ITEM_A, 'Cofrinho A'), linkedAccountId: null, transactions: [tx('t-2', PACC_2)] },
        ],
      },
      {
        itemId: ITEM_B,
        error: null,
        accounts: [{ ...acc(PACC_3, ITEM_B, 'Conta B'), linkedAccountId: null, transactions: [tx('t-3', PACC_3)] }],
      },
    ]);
  });

  it('without links it answers empty and never calls Pluggy', async () => {
    const { db } = readOnlyDb([]);
    const client = fakeClient();

    const preview = await previewOpenFinance({ householdId: HH, db, client, now: NOW });

    expect(preview.items).toEqual([]);
    expect(client.listAccounts).not.toHaveBeenCalled();
    expect(client.listTransactions).not.toHaveBeenCalled();
  });

  it('one item failing (e.g. expired authorization) shows the error on that item and keeps the others', async () => {
    const { db } = readOnlyDb([
      { pluggyItemId: ITEM_A, pluggyAccountId: null, accountId: null },
      { pluggyItemId: ITEM_B, pluggyAccountId: null, accountId: null },
    ]);
    const client = fakeClient({
      listAccounts: vi.fn(async (itemId: string) => {
        if (itemId === ITEM_A) throw new PluggyError('http', 400);
        return [acc(PACC_3, ITEM_B, 'Conta B')];
      }),
    });

    const preview = await previewOpenFinance({ householdId: HH, db, client, now: NOW });

    expect(preview.items[0]).toEqual({ itemId: ITEM_A, error: 'Pluggy answered with an error (HTTP 400)', accounts: [] });
    expect(preview.items[1].accounts).toHaveLength(1);
  });

  it('keys missing or refused fail the whole preview (every item would fail the same way)', async () => {
    const { db } = readOnlyDb([{ pluggyItemId: ITEM_A, pluggyAccountId: null, accountId: null }]);

    for (const kind of ['not_configured', 'auth'] as const) {
      const client = fakeClient({
        listAccounts: vi.fn(async () => {
          throw new PluggyError(kind);
        }),
      });
      await expect(previewOpenFinance({ householdId: HH, db, client, now: NOW })).rejects.toMatchObject({ kind });
    }
  });
});
