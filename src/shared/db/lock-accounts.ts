import { Prisma } from '../../generated/prisma/client.js';

/**
 * Locks account rows (SELECT ... FOR UPDATE) in ONE query, ordered by id. Every code path that takes more than one
 * account lock must go through here: two operations that cross (A to B and B to A) then take the rows in the same
 * order and cannot deadlock.
 */
export async function lockAccountsInOrder(tx: Prisma.TransactionClient, accountIds: string[]): Promise<void> {
  const ids = [...new Set(accountIds)].sort();
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT id FROM accounts WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
}
