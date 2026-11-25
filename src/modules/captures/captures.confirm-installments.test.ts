import { beforeEach, describe, expect, it, vi } from 'vitest';

// P22 L2: a capture confirmed in installments (`installments` 2..24) on a credit card. All installments are written in
// the SAME database transaction as the claim of the capture: first one through createTransaction (the capture's own
// sourceRef), the others through createInstallmentRowsInTx inside its hook. Invented data only.

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  capture: null as Row | null,
  account: null as Row | null,
  /** Household that was allowed to use `account` although it is not its own (a personal card a member shared). */
  grantedTo: null as string | null,
  shares: [] as Row[],
  transactions: [] as Row[],
  people: [] as Row[],
}));

vi.mock('../../shared/db/prisma.js', () => {
  const prisma = {
    capturedNotification: {
      findFirst: vi.fn(async () => (state.capture ? { ...state.capture } : null)),
      updateMany: vi.fn(async ({ data }: { data: Row }) => {
        if (state.capture?.status !== 'PENDING') return { count: 0 };
        Object.assign(state.capture, data);
        return { count: 1 };
      }),
    },
    account: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; householdId: string } }) =>
        state.account && state.account.id === where.id && state.account.householdId === where.householdId ? { ...state.account } : null),
    },
    person: {
      findMany: vi.fn(async ({ where }: { where: { householdId: string; id: { in: string[] } } }) =>
        state.people.filter((p) => p.householdId === where.householdId && where.id.in.includes(p.id as string))),
    },
    transactionShare: {
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        state.shares.push(...data);
        return { count: data.length };
      }),
    },
  };
  return { prisma };
});

vi.mock('../transactions/transactions.service.js', async () => {
  const { prisma } = await import('../../shared/db/prisma.js');
  const { NotFoundError } = await import('../../shared/errors/index.js');
  const rollbackOnFailure = async <T>(work: () => Promise<T>): Promise<T> => {
    const saved = { capture: { ...state.capture }, shares: [...state.shares], transactions: [...state.transactions] };
    try {
      return await work();
    } catch (error) {
      state.capture = saved.capture;
      state.shares = saved.shares;
      state.transactions = saved.transactions;
      throw error;
    }
  };
  return {
    // Stand-in of the account resolution createTransaction does (own household, or a personal account of a member who allowed it).
    resolveAccountForTransaction: vi.fn(async (householdId: string, accountId: string) => {
      const a = state.account;
      if (a && a.id === accountId && (a.householdId === householdId || state.grantedTo === householdId)) return { ...a };
      throw new NotFoundError('Account');
    }),
    // Stand-in: the hook runs inside the "transaction"; a failing hook rolls everything back.
    createTransaction: vi.fn(async (input: Row, _userId: string, hooks?: { inTransaction?: (tx: unknown, created: Row) => Promise<void> }) =>
      rollbackOnFailure(async () => {
        const row = { id: 'tx-1', type: 'EXPENSE', ...input };
        state.transactions.push(row);
        await hooks?.inTransaction?.(prisma, row);
        return row;
      })),
    createInstallmentRowsInTx: vi.fn(async (_tx: unknown, input: { rows: Array<Row> }) =>
      input.rows.map((row, i) => {
        const id = `tx-${i + 2}`;
        state.transactions.push({ id, ...row });
        return id;
      })),
    getTransactionWithHousehold: vi.fn(),
  };
});

const { confirmCapture } = await import('./captures.service.js');
const { confirmCaptureSchema } = await import('./captures.schema.js');
const transactionsService = await import('../transactions/transactions.service.js');
const { createTransaction, createInstallmentRowsInTx } = transactionsService;

const HH = 'hh-1';
const ANA = '33333333-3333-4333-8333-333333333333';
const CARD = '11111111-1111-4111-8111-111111111111';
const CHECKING = '22222222-2222-4222-8222-222222222222';
const KEY = 'ab'.repeat(20);

beforeEach(() => {
  vi.clearAllMocks();
  state.capture = { id: 'cap-1', householdId: HH, status: 'PENDING', transactionId: null, dedupKey: KEY, parsed: { kind: 'CARD_PURCHASE' } };
  state.account = { id: CARD, householdId: HH, type: 'CREDIT' };
  state.grantedTo = null;
  state.shares = [];
  state.transactions = [];
  state.people = [{ id: ANA, householdId: HH, name: 'Ana Teste', isActive: true }];
});

const body = (over: Row = {}) =>
  confirmCaptureSchema.parse({ type: 'EXPENSE', accountId: CARD, categoryName: 'FOOD', amount: 100, description: 'Loja Exemplo', date: '2026-09-15', ...over });
const confirm = (over: Row = {}) => confirmCapture({ householdId: HH, userId: 'u1' }, 'cap-1', body(over));

/** The rows createInstallmentRowsInTx was asked to write (installments 2..n). */
const extraRows = () => (vi.mocked(createInstallmentRowsInTx).mock.calls[0]![1] as unknown as { rows: Array<Row> }).rows;
const day = (d: unknown) => {
  const date = d as Date;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

describe('confirmCaptureSchema: installments', () => {
  it.each([[2], [3], [24]])('accepts %i installments', (installments) => {
    expect(body({ installments }).installments).toBe(installments);
  });

  it.each([[1], [0], [25], [2.5], [-3], ['x']])('rejects installments = %s', (installments) => {
    expect(() => body({ installments })).toThrow();
  });

  it('rejects installmentAmount without installments, and a non-positive installmentAmount', () => {
    expect(() => body({ installmentAmount: 30 })).toThrow(/installments/);
    expect(() => body({ installments: 3, installmentAmount: 0 })).toThrow();
    expect(() => body({ installments: 3, installmentAmount: -1 })).toThrow();
    expect(body({ installments: 3, installmentAmount: 30 }).installmentAmount).toBe(30);
  });
});

describe('confirmCapture in installments', () => {
  it('100,00 in 3x: 33,34 + 33,33 + 33,33, the first with the capture reference, all with the same plan', async () => {
    const result = await confirm({ installments: 3 });

    expect(result.created).toBe(true);
    expect(state.capture!.status).toBe('CONFIRMED');
    expect(createTransaction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createTransaction).mock.calls[0]![0]).toMatchObject({
      amount: 33.34, sourceRef: `notif:${KEY}`, installmentId: `notif:${KEY}`, installmentNumber: 1, totalInstallments: 3,
      accountId: CARD, type: 'EXPENSE', paid: true, categoryName: 'FOOD', description: 'Loja Exemplo',
    });
    expect(day(vi.mocked(createTransaction).mock.calls[0]![0].date)).toBe('2026-09-15');
    expect(extraRows().map((r) => [r.installmentNumber, r.amountCents, r.sourceRef, day(r.date)])).toEqual([
      [2, 3333, `notif:${KEY}:f1`, '2026-10-15'],
      [3, 3333, `notif:${KEY}:f2`, '2026-11-15'],
    ]);
    expect(vi.mocked(createInstallmentRowsInTx).mock.calls[0]![1]).toMatchObject({
      householdId: HH, installmentId: `notif:${KEY}`, totalInstallments: 3, account: { id: CARD, type: 'CREDIT' },
    });
  });

  it('the cents that are left go to the first installment, counted in whole cents', async () => {
    await confirm({ installments: 7, amount: 100 });
    const amounts = [vi.mocked(createTransaction).mock.calls[0]![0].amount, ...extraRows().map((r) => Number(r.amountCents) / 100)];
    expect(amounts).toEqual([14.32, 14.28, 14.28, 14.28, 14.28, 14.28, 14.28]);
    expect(Math.round(amounts.reduce((a, b) => a + b, 0) * 100)).toBe(10000);
  });

  it('a corrected installmentAmount is every installment', async () => {
    await confirm({ installments: 3, amount: 100, installmentAmount: 30.5 });
    expect(vi.mocked(createTransaction).mock.calls[0]![0].amount).toBe(30.5);
    expect(extraRows().map((r) => r.amountCents)).toEqual([3050, 3050]);
  });

  it('a purchase on the 31st: the following months are cut to their last day, from the purchase date', async () => {
    await confirm({ installments: 4, date: '2027-01-31' });
    expect(extraRows().map((r) => day(r.date))).toEqual(['2027-02-28', '2027-03-31', '2027-04-30']);
  });

  it('everything is written together: a failing later installment leaves the capture pending and nothing saved', async () => {
    vi.mocked(createInstallmentRowsInTx).mockRejectedValueOnce(new Error('boom'));
    await expect(confirm({ installments: 3 })).rejects.toThrow('boom');
    expect(state.capture!.status).toBe('PENDING');
    expect(state.capture!.transactionId).toBeNull();
    expect(state.transactions).toEqual([]);
  });

  it('confirming again creates nothing new', async () => {
    await confirm({ installments: 3 });
    vi.mocked(createTransaction).mockClear();
    vi.mocked(createInstallmentRowsInTx).mockClear();
    state.capture!.transactionId = 'tx-1';
    vi.mocked(transactionsService.getTransactionWithHousehold).mockResolvedValue({ id: 'tx-1' } as never);

    const again = await confirm({ installments: 3 });

    expect(again.created).toBe(false);
    expect(createTransaction).not.toHaveBeenCalled();
    expect(createInstallmentRowsInTx).not.toHaveBeenCalled();
  });

  it.each([
    ['a checking account', () => { state.account = { id: CARD, householdId: HH, type: 'CHECKING' }; }, {}],
    ['an income', () => undefined, { type: 'INCOME' }],
    ['a refund capture', () => { state.capture!.parsed = { kind: 'REFUND' }; }, { type: undefined }],
    ['a reference month', () => undefined, { competenceMonth: '2026-10' }],
    ['an amount too small to divide', () => undefined, { amount: 0.1, installments: 24 }],
  ])('400 for %s, writing nothing', async (_label, arrange, over) => {
    arrange();
    await expect(confirm({ installments: 3, ...over })).rejects.toMatchObject({ statusCode: 400 });
    expect(createTransaction).not.toHaveBeenCalled();
    expect(createInstallmentRowsInTx).not.toHaveBeenCalled();
    expect(state.capture!.status).toBe('PENDING');
  });

  it('an account outside the household that nobody shared is refused like the normal path (404), writing nothing', async () => {
    state.account = { id: CARD, householdId: 'other', type: 'CREDIT' };
    await expect(confirm({ installments: 3 })).rejects.toMatchObject({ statusCode: 404 });
    expect(createTransaction).not.toHaveBeenCalled();
    expect(state.capture!.status).toBe('PENDING');
  });

  it('a personal credit card of another member who allowed access is accepted, like createTransaction accepts it', async () => {
    state.account = { id: CARD, householdId: 'hh-personal-other', type: 'CREDIT' };
    state.grantedTo = HH;

    const result = await confirm({ installments: 3 });

    expect(result.created).toBe(true);
    expect(state.capture!.status).toBe('CONFIRMED');
    expect(vi.mocked(createInstallmentRowsInTx).mock.calls[0]![1]).toMatchObject({ householdId: HH, account: { id: CARD, type: 'CREDIT' } });
  });

  it('a shared account that is not a credit card is still refused (400)', async () => {
    state.account = { id: CARD, householdId: 'hh-personal-other', type: 'CHECKING' };
    state.grantedTo = HH;
    await expect(confirm({ installments: 3 })).rejects.toMatchObject({ statusCode: 400 });
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it('a refusal of the account resolution (403) goes up as is and nothing is written', async () => {
    vi.mocked(transactionsService.resolveAccountForTransaction).mockRejectedValueOnce(Object.assign(new Error('no'), { statusCode: 403 }));
    await expect(confirm({ installments: 3 })).rejects.toMatchObject({ statusCode: 403 });
    expect(createTransaction).not.toHaveBeenCalled();
    expect(state.capture!.status).toBe('PENDING');
  });

  it('the database transaction of an installment confirmation gets an explicit, generous timeout (24 installments split with someone are ~100 round trips)', async () => {
    await confirm({ installments: 24, shares: { strategy: 'equal', entries: [{ personId: ANA }] } });
    const hooks = vi.mocked(createTransaction).mock.calls[0]![2] as unknown as { transactionOptions?: { timeout?: number; maxWait?: number } };
    expect(hooks.transactionOptions?.timeout).toBeGreaterThanOrEqual(30_000);
    expect(hooks.transactionOptions?.maxWait).toBeGreaterThanOrEqual(10_000);
  });

  it('without installments the database transaction keeps its defaults (no options passed)', async () => {
    await confirm();
    const hooks = vi.mocked(createTransaction).mock.calls[0]![2] as unknown as { transactionOptions?: unknown };
    expect(hooks.transactionOptions).toBeUndefined();
  });

  it('without installments nothing changes: one transaction, no plan fields, no extra rows', async () => {
    await confirm();
    const input = vi.mocked(createTransaction).mock.calls[0]![0] as unknown as Row;
    expect(input).toMatchObject({ amount: 100, sourceRef: `notif:${KEY}` });
    expect(input).not.toHaveProperty('installmentId');
    expect(input).not.toHaveProperty('installmentNumber');
    expect(input).not.toHaveProperty('totalInstallments');
    expect(createInstallmentRowsInTx).not.toHaveBeenCalled();
  });

  it('a split ("Metade com") is written for every installment, calculated on that installment', async () => {
    await confirm({ installments: 4, shares: { strategy: 'equal', entries: [{ personId: ANA }] } });
    expect(state.shares.map((s) => [s.transactionId, Number(String(s.amount))])).toEqual([
      ['tx-1', 12.5], ['tx-2', 12.5], ['tx-3', 12.5], ['tx-4', 12.5],
    ]);
  });

  it('a split that does not fit an installment refuses everything before writing', async () => {
    await expect(confirm({ installments: 3, shares: { strategy: 'exact', entries: [{ personId: ANA, amount: 50 }] } })).rejects.toMatchObject({ statusCode: 400 });
    expect(createTransaction).not.toHaveBeenCalled();
    expect(state.capture!.status).toBe('PENDING');
  });
});
