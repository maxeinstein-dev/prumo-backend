import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';

const calls: string[] = [];
const lockArgs: any[][] = [];
const db = vi.hoisted(() => ({
  outerFindFirst: vi.fn(),
  txFindFirst: vi.fn(),
  txFindUnique: vi.fn(),
  lock: vi.fn(),
  txCreate: vi.fn(),
  applyTransfer: vi.fn(),
}));

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    account: { findFirst: db.outerFindFirst },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        $queryRaw: db.lock,
        account: { findFirst: db.txFindFirst, findUnique: db.txFindUnique },
        transaction: { create: db.txCreate },
      }),
  },
}));
vi.mock('../../shared/services/balance.service.js', () => ({
  applyTransfer: db.applyTransfer,
  updateBalanceForNormalTransaction: vi.fn(),
  recalculateCreditCardLimit: vi.fn(),
}));

const { transferBetweenAccounts } = await import('./accounts.service.js');

const dec = (n: number) => new Prisma.Decimal(n);
const FROM = '11111111-1111-4111-8111-111111111111';
const TO = '22222222-2222-4222-8222-222222222222';
const account = (id: string, available: number) => ({
  id, name: id === FROM ? 'Origem' : 'Destino', type: 'CHECKING', currency: 'BRL', balance: dec(available), availableBalance: dec(available),
});

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  lockArgs.length = 0;
  db.lock.mockImplementation(async (...args: any[]) => { calls.push('lock'); lockArgs.push(args); });
  db.applyTransfer.mockImplementation(async () => { calls.push('apply'); });
  db.txCreate.mockResolvedValue({ id: 't' });
  db.txFindUnique.mockResolvedValue({});
});

describe('transferBetweenAccounts: balance check', () => {
  it('uses the balance read inside the transaction, not the one read before it', async () => {
    // Before the transaction the source looks funded; by the time the transaction holds it, another transfer drained it.
    db.outerFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => account(where.id, 100));
    db.txFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => account(where.id, 5));
    await expect(transferBetweenAccounts('h1', { fromAccountId: FROM, toAccountId: TO, amount: 50 })).rejects.toThrow('Insufficient available balance');
    expect(db.applyTransfer).not.toHaveBeenCalled();
  });

  it('locks the source row before it moves the money', async () => {
    db.outerFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => account(where.id, 100));
    db.txFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => account(where.id, 100));
    await transferBetweenAccounts('h1', { fromAccountId: FROM, toAccountId: TO, amount: 50 });
    expect(calls).toEqual(['lock', 'apply']);
  });

  it('accepts a transfer the in-transaction balance covers even if the earlier read was lower', async () => {
    db.outerFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => account(where.id, 1));
    db.txFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => account(where.id, 100));
    await expect(transferBetweenAccounts('h1', { fromAccountId: FROM, toAccountId: TO, amount: 50 })).resolves.toBeTruthy();
  });
});

describe('transferBetweenAccounts: lock both accounts', () => {
  const lockedIds = (args: any[]) => args.slice(1).flatMap((a) => (a && a.values ? a.values : [a]));
  const run = async (from: string, to: string) => {
    db.outerFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => account(where.id, 100));
    db.txFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => account(where.id, 100));
    await transferBetweenAccounts('h1', { fromAccountId: from, toAccountId: to, amount: 10 });
  };

  it('takes both rows in one query, ordered by id, before any balance read or write', async () => {
    db.txFindFirst.mockClear();
    await run(FROM, TO);
    expect(db.lock).toHaveBeenCalledTimes(1);
    expect(lockedIds(lockArgs[0]!)).toEqual([FROM, TO]);
    expect(lockArgs[0]![0].join('?')).toMatch(/ORDER BY id FOR UPDATE/);
    expect(calls).toEqual(['lock', 'apply']);
  });

  it('uses the same order for the opposite direction (no crossed lock order)', async () => {
    await run(TO, FROM);
    expect(lockedIds(lockArgs[0]!)).toEqual([FROM, TO]);
  });
});
