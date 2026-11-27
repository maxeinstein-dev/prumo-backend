/**
 * A transfer between two own accounts moves the stored balance of BOTH accounts: total_balance as well as
 * available_balance, so total = available + allocated holds right after the transfer.
 *
 * Before the fix applyTransfer wrote `totalBalanceChange: 0`: only available_balance moved and total_balance stayed
 * stale until some later income/expense of that account recomputed it (updateBalanceForNormalTransaction rebuilds
 * total from available + allocated). An account that got an expense and then a transfer in kept the expense in its
 * total: an expense of 42 followed by a transfer in of 42 left total_balance at -42 while its rows add up to 0.
 */
import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { applyTransfer, updateBalanceForNormalTransaction } from './balance.service.js';

type Row = { id: string; type: string; isActive: boolean; balance: Prisma.Decimal; totalBalance: Prisma.Decimal; availableBalance: Prisma.Decimal; allocatedBalance: Prisma.Decimal };

function fakeTx(rows: Row[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const set = (row: Row, data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) {
      const current = row[key as keyof Row] as Prisma.Decimal;
      if (value && typeof value === 'object' && 'increment' in (value as object)) {
        (row as Record<string, unknown>)[key] = current.plus(new Prisma.Decimal((value as { increment: number }).increment));
      } else {
        (row as Record<string, unknown>)[key] = new Prisma.Decimal(value as Prisma.Decimal);
      }
    }
  };
  const tx = {
    account: {
      findFirst: async ({ where }: { where: { id: string; isActive?: boolean } }) => {
        const row = byId.get(where.id);
        return row && (where.isActive === undefined || row.isActive === where.isActive) ? { ...row } : null;
      },
      findUnique: async ({ where }: { where: { id: string } }) => (byId.has(where.id) ? { ...byId.get(where.id)! } : null),
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.filter((id) => byId.has(id)).map((id) => ({ ...byId.get(id)! })),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = byId.get(where.id)!;
        set(row, data);
        return { ...row };
      },
    },
  };
  return tx as unknown as Prisma.TransactionClient;
}

const account = (id: string, cents: number): Row => {
  const v = new Prisma.Decimal(cents).div(100);
  return { id, type: 'CHECKING', isActive: true, balance: v, totalBalance: v, availableBalance: v, allocatedBalance: new Prisma.Decimal(0) };
};

const money = (row: Row) => ({ total: row.totalBalance.toNumber(), available: row.availableBalance.toNumber(), allocated: row.allocatedBalance.toNumber() });

describe('applyTransfer moves the stored balance of both accounts', () => {
  it('credits total_balance of the destination and debits it from the source', async () => {
    const from = account('acc-from', 20_000);
    const to = account('acc-to', 3_000);
    await applyTransfer(fakeTx([from, to]), from.id, to.id, 75);

    expect(money(from)).toEqual({ total: 125, available: 125, allocated: 0 });
    expect(money(to)).toEqual({ total: 105, available: 105, allocated: 0 });
  });

  it('an expense followed by a transfer in of the same amount leaves the destination at zero', async () => {
    const from = account('acc-from', 40_000);
    const to = account('acc-to', 0);
    const tx = fakeTx([from, to]);

    await updateBalanceForNormalTransaction(tx, to.id, -42);
    await applyTransfer(tx, from.id, to.id, 42);

    expect(money(to)).toEqual({ total: 0, available: 0, allocated: 0 });
    expect(money(from)).toEqual({ total: 358, available: 358, allocated: 0 });
  });

  it('undoing a transfer (deleteTransaction applies it reversed) restores both totals', async () => {
    const from = account('acc-from', 10_000);
    const to = account('acc-to', 1_000);
    const tx = fakeTx([from, to]);

    await applyTransfer(tx, from.id, to.id, 30);
    await applyTransfer(tx, to.id, from.id, 30);

    expect(money(from)).toEqual({ total: 100, available: 100, allocated: 0 });
    expect(money(to)).toEqual({ total: 10, available: 10, allocated: 0 });
  });
});
