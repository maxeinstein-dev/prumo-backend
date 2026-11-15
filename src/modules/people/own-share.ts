/**
 * Own share of an expense: what is really the user's part of a transaction that other people took part in.
 *
 *   own share = |amount| - (sum of the shares THEY_OWE_ME of that transaction), never below zero.
 *
 * Same subtraction the people module already shows as `myPart` (see `buildResponse` in shares.service.ts), with a floor
 * at zero. Shares in the other direction (I_OWE_THEM) do not change it: they are money the user owes for something
 * another person paid, not a slice of the user's own expense. Settlements never enter: they move money between the
 * user and a person, they do not change what a purchase cost. Only EXPENSE transactions have an own share; the callers
 * leave income, transfers, card payments and adjustments as they are. Whole cents.
 *
 * A refund (INCOME with `isRefund`, it cancels an expense) can be divided the same way, and then its own part is what
 * comes off the spending: `signedOwnCents` gives the signed own amount of a row of the spending set (expense: plus its
 * own share; refund: minus its own share). A refund has no link to the purchase it cancels, so a refund nobody divided
 * is entirely the user's own money coming back: purchase 100 with 50 of another person, refunded with no division,
 * leaves 50 - 100 = -50 of own spending. To net to zero the user divides the refund like the purchase.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { storedToCents } from './money.js';

export function ownAmountCents(amountCents: number, theirCents: number): number {
  return Math.max(0, Math.abs(amountCents) - Math.max(0, theirCents));
}

/** What the people owe the user on one expense transaction, with the data a budget needs to place it. */
export interface TheirShare {
  transactionId: string;
  /** Sum of the THEY_OWE_ME shares of the transaction. */
  theirCents: number;
  /** |amount| of the transaction. */
  amountCents: number;
  categoryName: string | null;
  /** The transaction is a refund (an income that cancels an expense): its own part counts as negative spending. */
  isRefund?: boolean;
}

/** Signed own cents of a row of the spending set: an expense adds its own share, a refund takes its own share off. */
export function signedOwnCents(
  row: { id: string; type?: string; isRefund?: boolean | null; amount: { toNumber(): number } },
  theirShares: ReadonlyMap<string, Pick<TheirShare, 'theirCents'>>,
): number {
  const own = ownAmountCents(storedToCents(row.amount), theirShares.get(row.id)?.theirCents ?? 0);
  return row.type === 'INCOME' && row.isRefund === true ? -own : own;
}

/** Cents of the amount the own share takes off the expense (the part that belongs to others, at most the whole). */
export function deductionCents(share: Pick<TheirShare, 'theirCents' | 'amountCents'>): number {
  return share.amountCents - ownAmountCents(share.amountCents, share.theirCents);
}

/**
 * The THEY_OWE_ME shares of the household's EXPENSE transactions (and refunds) matching `transactionWhere`, summed per transaction.
 * One query over the shares only (not over every transaction); a transaction of another household never matches.
 */
export async function loadTheirShares(
  db: Pick<Prisma.TransactionClient, 'transactionShare'>,
  householdId: string,
  transactionWhere: Prisma.TransactionWhereInput = {},
): Promise<Map<string, TheirShare>> {
  const rows = await db.transactionShare.findMany({
    where: {
      householdId,
      direction: 'THEY_OWE_ME',
      transaction: { AND: [{ householdId }, { OR: [{ type: 'EXPENSE' }, { type: 'INCOME', isRefund: true }] }, transactionWhere] },
    },
    select: { transactionId: true, amount: true, transaction: { select: { amount: true, categoryName: true, isRefund: true } } },
  });
  const out = new Map<string, TheirShare>();
  for (const row of rows) {
    const current = out.get(row.transactionId);
    const theirCents = storedToCents(row.amount);
    if (current) current.theirCents += theirCents;
    else out.set(row.transactionId, { transactionId: row.transactionId, theirCents, amountCents: Math.abs(storedToCents(row.transaction.amount)), categoryName: row.transaction.categoryName, isRefund: row.transaction.isRefund === true });
  }
  return out;
}
