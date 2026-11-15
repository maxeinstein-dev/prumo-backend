import { beforeEach, describe, expect, it, vi } from 'vitest';

// A capture of kind REFUND (Nubank "A compra em X foi estornada") is confirmed as a refund: an income that cancels an
// expense, in the category the user picks (the purchase's). Invented data only.
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ capture: null as Row | null, created: [] as Row[] }));

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    capturedNotification: {
      findFirst: vi.fn(async () => (state.capture ? { ...state.capture } : null)),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    person: { findMany: vi.fn(async () => []) },
    transactionShare: { createMany: vi.fn(async () => ({ count: 0 })) },
  },
}));
vi.mock('../transactions/transactions.service.js', () => ({
  createTransaction: vi.fn(async (input: Row) => {
    state.created.push(input);
    return { id: 'tx-new', ...input };
  }),
  getTransactionWithHousehold: vi.fn(),
}));

const { confirmCapture } = await import('./captures.service.js');
const { confirmCaptureSchema } = await import('./captures.schema.js');

const HH = 'hh-1';
const ACC = '11111111-1111-4111-8111-111111111111';
const capture = (kind: string | null) => ({
  id: 'cap-1', householdId: HH, status: 'PENDING', transactionId: null, dedupKey: 'k'.repeat(40),
  parsed: kind ? { kind, type: kind === 'REFUND' ? 'INCOME' : 'EXPENSE', amount: 30 } : null,
});
const body = (over: Row = {}) => confirmCaptureSchema.parse({ accountId: ACC, categoryName: 'GROCERIES', amount: 30, date: '2026-10-12', ...over });
const confirm = (over: Row = {}) => confirmCapture({ householdId: HH, userId: 'u1' }, 'cap-1', body(over));

beforeEach(() => {
  vi.clearAllMocks();
  state.created = [];
});

describe('confirming a capture of kind REFUND', () => {
  it('writes an income marked as a refund, in the expense category the user chose', async () => {
    state.capture = capture('REFUND');
    await confirm({ type: 'INCOME' });
    expect(state.created[0]).toMatchObject({ type: 'INCOME', categoryName: 'GROCERIES', isRefund: true, sourceRef: `notif:${'k'.repeat(40)}` });
  });

  it('with no type sent, the refund is still an income (an expense category must not turn it into an expense)', async () => {
    state.capture = capture('REFUND');
    await confirm();
    expect(state.created[0]).toMatchObject({ type: 'INCOME', isRefund: true });
  });

  it('when the user turns it into an expense it is not a refund', async () => {
    state.capture = capture('REFUND');
    await confirm({ type: 'EXPENSE' });
    expect(state.created[0]).toMatchObject({ type: 'EXPENSE' });
    expect(state.created[0]).not.toHaveProperty('isRefund');
  });

  it('other kinds and unread captures are never refunds', async () => {
    for (const kind of ['CARD_PURCHASE', 'PIX_IN', null]) {
      state.created = [];
      state.capture = capture(kind);
      await confirm({ type: 'INCOME', categoryName: 'SALARY' });
      expect(state.created[0], String(kind)).not.toHaveProperty('isRefund');
    }
  });

  it('the client cannot send the marker itself (the body stays strict)', () => {
    expect(confirmCaptureSchema.safeParse({ accountId: ACC, categoryName: 'FOOD', amount: 1, date: '2026-10-12', isRefund: true }).success).toBe(false);
  });
});
