import { describe, expect, it, vi } from 'vitest';

import { importOpenFinance, type ImportDb } from './open-finance.import.js';
import type { PluggyAccount, PluggyClient, PluggyTransaction } from './pluggy.client.js';

// Invented ids, names and values only.
const HH = '11111111-1111-4111-8111-111111111111';
const OWNER = '99999999-9999-4999-8999-999999999999';
const ITEM_W = 'aaaaaaaa-0000-4000-8000-00000000000a';
const ITEM_B = 'aaaaaaaa-0000-4000-8000-00000000000b';
const PW = 'bbbbbbbb-0000-4000-8000-0000000000a1';
const PB = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const ACC_W = 'cccccccc-0000-4000-8000-000000000001';
const ACC_B = 'cccccccc-0000-4000-8000-000000000002';

let seq = 0;
const tid = () => `dddddddd-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const t = (accountId: string, date: string, amount: number, description: string, id = tid()): PluggyTransaction => ({
  id,
  accountId,
  date,
  amount,
  description,
  type: amount < 0 ? 'DEBIT' : 'CREDIT',
  status: 'POSTED',
});
const acc = (id: string, itemId: string): PluggyAccount => ({
  id,
  itemId,
  type: 'BANK',
  subtype: 'CHECKING_ACCOUNT',
  name: 'Conta',
  marketingName: null,
  number: '0000',
  balance: 0,
  currencyCode: 'BRL',
});

function fakeClient(tx: Record<string, PluggyTransaction[]>, blocked: string[] = []): PluggyClient {
  return {
    checkCredentials: vi.fn(async () => 'ok' as const),
    getItem: vi.fn(async (id: string) => ({
      id,
      status: blocked.includes(id) ? 'LOGIN_ERROR' : 'UPDATED',
      executionStatus: blocked.includes(id) ? 'USER_AUTHORIZATION_EXPIRED' : 'SUCCESS',
      consentExpiresAt: null,
      connectorName: null,
    })),
    listAccounts: vi.fn(async (id: string) => (id === ITEM_W ? [acc(PW, ITEM_W)] : [acc(PB, ITEM_B)])),
    listInvestments: vi.fn(async () => []),
    listTransactions: vi.fn(async (accountId: string) => tx[accountId] ?? []),
  };
}

type Row = Record<string, any>;

function fakeDb(options: { importFrom?: string | null; prumo?: Row[]; refs?: Row[]; captures?: Row[]; savings?: Row[] } = {}) {
  const importFrom = options.importFrom === undefined ? null : options.importFrom;
  const state = {
    links: [
      { id: 'link-w', pluggyItemId: ITEM_W, pluggyAccountId: PW, accountId: ACC_W, importFrom: importFrom ? new Date(`${importFrom}T00:00:00Z`) : null, lastSyncAt: null, lastError: null },
      { id: 'link-b', pluggyItemId: ITEM_B, pluggyAccountId: PB, accountId: ACC_B, importFrom: importFrom ? new Date(`${importFrom}T00:00:00Z`) : null, lastSyncAt: null, lastError: null },
    ] as Row[],
    refs: [...(options.refs ?? [])] as Row[],
    captures: [...(options.captures ?? [])] as Row[],
  };
  const db = {
    openFinanceLink: {
      findMany: vi.fn(async () => state.links),
      update: vi.fn(async ({ where, data }: Row) => {
        const link = state.links.find((l) => l.id === where.id)!;
        Object.assign(link, data);
        return link;
      }),
    },
    account: { findMany: vi.fn(async () => [{ id: ACC_W, type: 'CHECKING' }, { id: ACC_B, type: 'CHECKING' }]) },
    openFinanceSavings: { findMany: vi.fn(async () => options.savings ?? []) },
    transaction: { findMany: vi.fn(async () => options.prumo ?? []) },
    transactionExternalRef: {
      findMany: vi.fn(async () => state.refs),
      createMany: vi.fn(async ({ data }: Row) => {
        for (const r of data) if (!state.refs.some((x) => x.ref === r.ref)) state.refs.push(r);
        return { count: data.length };
      }),
    },
    capturedNotification: {
      findMany: vi.fn(async () => state.captures),
      createMany: vi.fn(async ({ data }: Row) => {
        for (const c of data) if (!state.captures.some((x) => x.dedupKey === c.dedupKey)) state.captures.push(c);
        return { count: data.length };
      }),
    },
    householdMember: { findFirst: vi.fn(async () => ({ userId: OWNER })) },
  };
  return { db: db as unknown as ImportDb, raw: db, state };
}

const NOW = new Date('2026-12-02T15:00:00.000Z');

describe('importOpenFinance', () => {
  it('first run: starts drafts from today, but references what Prumo already has in the last days', async () => {
    const matchedId = tid();
    const tx = {
      [PW]: [
        t(PW, '2026-11-25', -22.5, 'Pix enviado Loja', matchedId), // Prumo has it
        t(PW, '2026-11-26', -12, 'Pix enviado Padaria'), // missing, but before the start: no draft
        t(PW, '2026-12-02', -6, 'Pagamento com Pix Feira'), // missing, from the start on: draft
      ],
    };
    const prumo = [{ id: 'p-1', type: 'EXPENSE', accountId: ACC_W, fromAccountId: null, toAccountId: null, amount: '22.50', date: new Date('2026-11-25T00:00:00Z'), description: 'Loja', paid: true }];
    const { db, state } = fakeDb({ prumo });

    const result = await importOpenFinance({ householdId: HH, db, client: fakeClient(tx), now: NOW });

    expect(state.links.map((l) => l.importFrom)).toEqual([new Date('2026-12-02T00:00:00Z'), new Date('2026-12-02T00:00:00Z')]);
    expect(state.refs).toEqual([{ householdId: HH, transactionId: 'p-1', ref: `pluggy:${matchedId}` }]);
    expect(state.captures).toHaveLength(1);
    expect(state.captures[0]).toMatchObject({
      householdId: HH,
      userId: OWNER,
      package: 'open-finance',
      title: 'Open Finance',
      text: 'Pagamento com Pix Feira',
      postedAt: new Date('2026-12-02T15:00:00.000Z'),
      status: 'PENDING',
      parsed: { kind: 'PIX_OUT', type: 'EXPENSE', amountCents: 600, amount: 6, description: 'Pagamento com Pix Feira', accountId: ACC_W, source: 'open-finance' },
    });
    expect(state.captures[0].dedupKey.length).toBeLessThanOrEqual(40);
    expect(result).toMatchObject({ refs: 1, drafts: 1, transferDrafts: 0, yieldDrafts: 0 });
    expect(state.links.every((l) => l.lastSyncAt instanceof Date && l.lastError === null)).toBe(true);
  });

  it('a move between own accounts after the start becomes one transfer draft: two captures with the same pairKey', async () => {
    const tx = {
      [PW]: [t(PW, '2026-12-01', -750, 'Pix enviado Titular')],
      [PB]: [t(PB, '2026-12-01', 750, 'Transferência recebida Titular')],
    };
    const { db, state } = fakeDb({ importFrom: '2026-11-27' });

    const result = await importOpenFinance({ householdId: HH, db, client: fakeClient(tx), now: NOW });

    expect(result).toMatchObject({ drafts: 0, transferDrafts: 1 });
    const [out, inn] = state.captures;
    expect(out.parsed).toMatchObject({ kind: 'PIX_OUT', type: 'EXPENSE', amountCents: 75000, accountId: ACC_W });
    expect(inn.parsed).toMatchObject({ kind: 'PIX_IN', type: 'INCOME', amountCents: 75000, accountId: ACC_B, warning: 'POSSIBLE_OWN_TRANSFER' });
    expect(out.parsed.pairKey).toBeTruthy();
    expect(inn.parsed.pairKey).toBe(out.parsed.pairKey);
    expect(inn.postedAt).toEqual(out.postedAt);
  });

  it('running again writes nothing new: lines already referenced or drafted are left alone, and their Prumo transaction is not reused', async () => {
    const tx = { [PW]: [t(PW, '2026-12-01', -40, 'Pix enviado Loja'), t(PW, '2026-12-01', -40, 'Pix enviado Outra')] };
    const prumo = [{ id: 'p-1', type: 'EXPENSE', accountId: ACC_W, fromAccountId: null, toAccountId: null, amount: '40.00', date: new Date('2026-12-01T00:00:00Z'), description: 'Loja', paid: true }];
    const { db, state, raw } = fakeDb({ importFrom: '2026-11-27', prumo });
    const client = fakeClient(tx);

    await importOpenFinance({ householdId: HH, db, client, now: NOW });
    expect(state.refs).toHaveLength(1);
    expect(state.captures).toHaveLength(1);

    raw.transactionExternalRef.createMany.mockClear();
    raw.capturedNotification.createMany.mockClear();
    const again = await importOpenFinance({ householdId: HH, db, client, now: NOW });
    expect(again).toMatchObject({ refs: 0, drafts: 0 });
    expect(raw.transactionExternalRef.createMany).not.toHaveBeenCalled();
    expect(raw.capturedNotification.createMany).not.toHaveBeenCalled();
  });

  it('one yield draft per day the savings yield comes in (from the start on), with the share of Prumo that day', async () => {
    const tx = {
      [PW]: [
        t(PW, '2026-11-26', 0.5, 'Rendimentos'), // before the start: no draft
        t(PW, '2026-11-30', 0.01, 'Rendimentos'),
        t(PW, '2026-11-30', 0.09, 'Rendimentos'), // 10 cents that day: 10 % is Prumo's -> 1 cent
        t(PW, '2026-12-01', 5, 'Rendimentos'), // 500 cents -> 50 cents, today's month too
      ],
    };
    const savings = [
      { name: 'Cofrinho Azul', aliases: [], inPrumo: true, approxBalance: '100.00', balanceAsOf: new Date('2026-11-01T00:00:00Z') },
      { name: 'Cofrinho Pai', aliases: [], inPrumo: false, approxBalance: '900.00', balanceAsOf: new Date('2026-11-01T00:00:00Z') },
    ];
    const { db, state } = fakeDb({ importFrom: '2026-11-27', savings });

    const result = await importOpenFinance({ householdId: HH, db, client: fakeClient(tx), now: NOW });

    expect(result.yieldDrafts).toBe(2);
    expect(state.captures.map((c) => [c.text, c.postedAt, c.parsed.amountCents, c.parsed.type, c.parsed.accountId])).toEqual([
      ['Rendimento dos cofrinhos em 30/11/2026', new Date('2026-11-30T15:00:00.000Z'), 1, 'INCOME', ACC_W],
      ['Rendimento dos cofrinhos em 01/12/2026', new Date('2026-12-01T15:00:00.000Z'), 50, 'INCOME', ACC_W],
    ]);
    expect(new Set(state.captures.map((c) => c.dedupKey)).size).toBe(2);
  });

  it('no yield draft when the share of Prumo is unknown, or rounds to zero', async () => {
    const tx = { [PW]: [t(PW, '2026-12-01', 10, 'Rendimentos')] };
    const unknown = fakeDb({ importFrom: '2026-11-27', savings: [] });
    expect((await importOpenFinance({ householdId: HH, db: unknown.db, client: fakeClient(tx), now: NOW })).yieldDrafts).toBe(0);
    const tiny = { [PW]: [t(PW, '2026-12-01', 0.04, 'Rendimentos')] }; // 10 % of 4 cents -> 0
    const savings = [
      { name: 'Cofrinho Azul', aliases: [], inPrumo: true, approxBalance: '100.00', balanceAsOf: new Date('2026-11-01T00:00:00Z') },
      { name: 'Cofrinho Pai', aliases: [], inPrumo: false, approxBalance: '900.00', balanceAsOf: new Date('2026-11-01T00:00:00Z') },
    ];
    const zero = fakeDb({ importFrom: '2026-11-27', savings });
    expect((await importOpenFinance({ householdId: HH, db: zero.db, client: fakeClient(tiny), now: NOW })).yieldDrafts).toBe(0);
  });

  it('a line already waiting in the box as a notification (same kind and value, same or next day) is not drafted again', async () => {
    const tx = { [PW]: [t(PW, '2026-12-01', 15, 'Pix recebido Fulana'), t(PW, '2026-12-01', -9, 'Pix enviado Loja')] };
    const notification = {
      householdId: HH,
      package: 'com.example.bank',
      dedupKey: 'notif-1',
      status: 'PENDING',
      postedAt: new Date('2026-12-01T13:05:00.000Z'),
      parsed: { kind: 'PIX_IN', type: 'INCOME', amountCents: 1500 },
    };
    const { db, state } = fakeDb({ importFrom: '2026-11-27', captures: [notification] });

    const result = await importOpenFinance({ householdId: HH, db, client: fakeClient(tx), now: NOW });

    expect(result.drafts).toBe(1);
    expect(state.captures.filter((c) => c.package === 'open-finance').map((c) => c.text)).toEqual(['Pix enviado Loja']);
  });

  it('records the bank balance of each account: the account plus the estimate of its Prumo savings (estimated), or the account alone', async () => {
    const tx = {
      [PW]: [t(PW, '2026-12-01', -10, 'Dinheiro reservado Cofrinho Azul'), t(PW, '2026-12-01', 10, 'Dinheiro reservado')],
      [PB]: [],
    };
    const savings = [{ name: 'Cofrinho Azul', aliases: [], inPrumo: true, approxBalance: '100.00', balanceAsOf: new Date('2026-11-30T00:00:00Z') }];
    const { db, state } = fakeDb({ importFrom: '2026-11-27', savings });
    const client = fakeClient(tx);
    client.listAccounts = vi.fn(async (id: string) =>
      id === ITEM_W ? [{ ...acc(PW, ITEM_W), balance: 0.5 }] : [{ ...acc(PB, ITEM_B), balance: 12.34 }],
    );

    await importOpenFinance({ householdId: HH, db, client, now: NOW });

    const w = state.links.find((l) => l.id === 'link-w')!;
    const b = state.links.find((l) => l.id === 'link-b')!;
    // 0,50 in the account + 100,00 registered + 10,00 put into the savings on 01/12.
    expect([w.bankBalance, w.bankBalanceEstimated, w.bankBalanceAt]).toEqual([110.5, true, NOW]);
    expect([b.bankBalance, b.bankBalanceEstimated]).toEqual([12.34, false]);
  });

  it('an item with expired authorization is not read: its links keep the error, nothing is drafted for it', async () => {
    const tx = { [PW]: [t(PW, '2026-12-01', -6, 'Pix enviado Feira')] };
    const { db, state } = fakeDb({ importFrom: '2026-11-27' });

    const result = await importOpenFinance({ householdId: HH, db, client: fakeClient(tx, [ITEM_W]), now: NOW });

    expect(state.captures).toEqual([]);
    expect(state.links.find((l) => l.id === 'link-w')!.lastError).toBe('A autorização deste banco venceu: reconecte no Meu Pluggy.');
    expect(result.blocked).toEqual([{ itemId: ITEM_W, reason: 'A autorização deste banco venceu: reconecte no Meu Pluggy.' }]);
  });
});
