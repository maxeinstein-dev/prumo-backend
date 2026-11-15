import { beforeEach, describe, expect, it, vi } from 'vitest';

// P19 L3: a capture confirmed with "Metade com" / "É de" writes the shares in the SAME database transaction as the
// transaction and the claim of the capture, so there is never a confirmed transaction without its split.

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  capture: null as Row | null,
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
  return {
    // Stand-in: the hook runs inside the "transaction"; a failing hook rolls everything back.
    createTransaction: vi.fn(async (input: Row, _userId: string, hooks?: { inTransaction?: (tx: unknown, created: { id: string }) => Promise<void> }) => {
      const row = { id: 'tx-new', ...input };
      const saved = { capture: { ...state.capture }, shares: [...state.shares] };
      try {
        await hooks?.inTransaction?.(prisma, row);
      } catch (error) {
        state.capture = saved.capture;
        state.shares = saved.shares;
        throw error;
      }
      state.transactions.push(row);
      return row;
    }),
    getTransactionWithHousehold: vi.fn(),
  };
});

const { confirmCapture } = await import('./captures.service.js');
const { confirmCaptureSchema } = await import('./captures.schema.js');

// Invented data only.
const HH = 'hh-1';
const ANA = '33333333-3333-4333-8333-333333333333';
const GONE = '44444444-4444-4444-8444-444444444444';
const ACC = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  state.capture = { id: 'cap-1', householdId: HH, status: 'PENDING', transactionId: null, dedupKey: 'k'.repeat(40) };
  state.shares = [];
  state.transactions = [];
  state.people = [
    { id: ANA, householdId: HH, name: 'Ana Teste', isActive: true },
    { id: GONE, householdId: HH, name: 'Pessoa Inativa', isActive: false },
  ];
});

const body = (over: Row = {}) =>
  confirmCaptureSchema.parse({ type: 'EXPENSE', accountId: ACC, categoryName: 'FOOD', amount: 45.01, date: '2026-12-03', ...over });

describe('confirmCapture with a split (P19 L3)', () => {
  it('"Metade com" creates the transaction, the share and claims the capture together', async () => {
    const result = await confirmCapture({ householdId: HH, userId: 'u1' }, 'cap-1', body({ shares: { strategy: 'equal', entries: [{ personId: ANA }] } }));
    expect(result.created).toBe(true);
    expect(state.capture!.status).toBe('CONFIRMED');
    expect(state.shares).toEqual([expect.objectContaining({ transactionId: 'tx-new', personId: ANA, direction: 'THEY_OWE_ME' })]);
    expect(Number(String(state.shares[0]!.amount))).toBe(22.51);
    // The split never reaches createTransaction as a field of the transaction
    expect(state.transactions[0]).not.toHaveProperty('shares');
  });

  it('without a split nothing changes (no share)', async () => {
    await confirmCapture({ householdId: HH, userId: 'u1' }, 'cap-1', body());
    expect(state.transactions).toHaveLength(1);
    expect(state.shares).toEqual([]);
  });

  it('a bad split (inactive person, income) creates nothing and leaves the capture pending', async () => {
    await expect(confirmCapture({ householdId: HH, userId: 'u1' }, 'cap-1', body({ shares: { strategy: 'equal', entries: [{ personId: GONE }] } }))).rejects.toThrow(/inactive/);
    await expect(confirmCapture({ householdId: HH, userId: 'u1' }, 'cap-1', body({ type: 'INCOME', shares: { strategy: 'equal', entries: [{ personId: ANA }] } }))).rejects.toThrow(/expense/);
    expect(state.transactions).toEqual([]);
    expect(state.shares).toEqual([]);
    expect(state.capture!.status).toBe('PENDING');
  });

  it('the schema takes only percent, exact and equal, with at least one person', () => {
    expect(() => body({ shares: { strategy: 'shares', entries: [{ personId: ANA, shares: 1 }] } })).toThrow();
    expect(() => body({ shares: { strategy: 'equal', entries: [] } })).toThrow();
  });
});
