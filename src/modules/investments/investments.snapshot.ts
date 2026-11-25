import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { listPositions, loadAccount } from './investments.service.js';

/**
 * Daily picture of the investment accounts (P21 L2).
 *
 * For every active INVESTMENT account that has at least one position, the total of the day (positions at market value
 * plus the cash at the broker, the same figure as GET /investments/accounts/:id/positions) goes into account_valuations,
 * one row per account and day (upsert: running twice never duplicates). The net worth already reads the latest value up
 * to the end of each month from that table, so it shows the picture with no rule of its own.
 *
 * An account with no position is never touched: its typed values stay the only ones. Older rows are never changed; only
 * the row of the given day is written (a value typed by hand for that same day is replaced, as the total is now computed).
 */

export interface SnapshotResult {
  recorded: Array<{ accountId: string; totalCents: number }>;
  /** Ids only: no names or amounts in what is reported. */
  failedAccountIds: string[];
}

export async function recordAccountSnapshots(asOf: string): Promise<SnapshotResult> {
  const holders = (await prisma.investmentPosition.findMany({
    where: { account: { isActive: true, type: 'INVESTMENT' } },
    select: { accountId: true },
    distinct: ['accountId'],
  })) as Array<{ accountId: string }>;

  const result: SnapshotResult = { recorded: [], failedAccountIds: [] };
  for (const { accountId } of holders) {
    try {
      const account = await loadAccount(accountId);
      const { summary } = await listPositions(account, { asOf });
      const totalCents = Math.round(summary.totalValue * 100);
      const amount = new Prisma.Decimal(totalCents).div(100);
      const date = new Date(`${asOf}T00:00:00.000Z`);
      await prisma.accountValuation.upsert({
        where: { accountId_date: { accountId, date } },
        create: { accountId, date, amount },
        update: { amount },
      });
      result.recorded.push({ accountId, totalCents });
    } catch {
      result.failedAccountIds.push(accountId);
    }
  }
  return result;
}
