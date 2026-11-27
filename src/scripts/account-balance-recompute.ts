/**
 * Pure balance recomputation used by recompute-account-balances-safe.ts.
 * Kept apart from the script so it can be tested without a database.
 */
import { AccountType, TransactionType } from '../shared/enums/index.js';

export interface RecomputeAccount {
  id: string;
  type: string;
  creditLimit: number;
}

export interface RecomputeTransaction {
  type: string;
  amount: number;
  paid: boolean | null;
  accountId: string | null;
  fromAccountId: string | null;
  toAccountId: string | null;
  relatedEntityId: string | null;
}

export interface RecomputedBalance {
  balance: number;
  totalBalance: number;
  availableBalance: number;
  allocatedBalance: number;
  /** Only for CREDIT accounts. */
  totalLimit?: number;
}

/** Where clause for the transactions that move the balances of the affected accounts. */
export function recomputeTransactionsWhere(affectedAccountIds: string[]) {
  return {
    type: { in: [TransactionType.INCOME, TransactionType.EXPENSE, TransactionType.TRANSFER, TransactionType.ALLOCATION] },
    // A transfer is stored with accountId = source, so one coming in from an unaffected account is only found
    // by toAccountId; a credit card's allocations are stored on the paying account (relatedEntityId = card).
    OR: [
      { accountId: { in: affectedAccountIds } },
      { fromAccountId: { in: affectedAccountIds } },
      { toAccountId: { in: affectedAccountIds } },
      { relatedEntityId: { in: affectedAccountIds } },
    ],
  };
}

function calculateBalanceChange(amount: number, isIncome: boolean, accountType: string): number {
  const isCreditCard = accountType === AccountType.CREDIT;
  if (isCreditCard) return isIncome ? -amount : amount;
  return isIncome ? amount : -amount;
}

export function computeAccountBalances(
  accounts: RecomputeAccount[],
  transactions: RecomputeTransaction[],
  affectedAccountIds: string[]
): Map<string, RecomputedBalance> {
  const affected = new Set(affectedAccountIds);
  const accountTypeMap = new Map(accounts.map(a => [a.id, a.type]));

  const totalDelta = new Map<string, number>();
  const transferDelta = new Map<string, number>();
  const allocatedDelta = new Map<string, number>();
  const creditCardAllocationDelta = new Map<string, number>();

  for (const t of transactions) {
    const amount = t.amount;
    const paid = t.paid !== false;

    if (t.type === TransactionType.TRANSFER && t.fromAccountId && t.toAccountId) {
      if (affected.has(t.fromAccountId)) {
        transferDelta.set(t.fromAccountId, (transferDelta.get(t.fromAccountId) ?? 0) - amount);
      }
      if (affected.has(t.toAccountId)) {
        transferDelta.set(t.toAccountId, (transferDelta.get(t.toAccountId) ?? 0) + amount);
      }
      continue;
    }

    if (t.type === TransactionType.ALLOCATION && t.accountId && t.relatedEntityId) {
      const signed = Math.abs(amount) * (amount >= 0 ? 1 : -1);
      if (affected.has(t.accountId)) {
        allocatedDelta.set(t.accountId, (allocatedDelta.get(t.accountId) ?? 0) + signed);
      }
      if (affected.has(t.relatedEntityId)) {
        creditCardAllocationDelta.set(t.relatedEntityId, (creditCardAllocationDelta.get(t.relatedEntityId) ?? 0) + signed);
      }
      continue;
    }

    if ((t.type === TransactionType.INCOME || t.type === TransactionType.EXPENSE) && paid && t.accountId && affected.has(t.accountId)) {
      const accountType = accountTypeMap.get(t.accountId);
      if (!accountType) continue;
      const change = calculateBalanceChange(amount, t.type === TransactionType.INCOME, accountType);
      totalDelta.set(t.accountId, (totalDelta.get(t.accountId) ?? 0) + change);
    }
  }

  const result = new Map<string, RecomputedBalance>();
  for (const acc of accounts) {
    if (!affected.has(acc.id)) continue;
    const total = totalDelta.get(acc.id) ?? 0;
    const transfer = transferDelta.get(acc.id) ?? 0;
    const allocated = allocatedDelta.get(acc.id) ?? 0;

    if (acc.type === AccountType.CREDIT) {
      const balance = Math.max(0, total);
      const allocationDelta = creditCardAllocationDelta.get(acc.id) ?? 0;
      result.set(acc.id, {
        balance,
        totalBalance: balance,
        availableBalance: 0,
        allocatedBalance: 0,
        totalLimit: Math.max(0, acc.creditLimit + allocationDelta),
      });
    } else {
      // Same model as applyTransfer (balance.service.ts): a transfer moves total AND available, and
      // total = available + allocated. Transfers used to count only in available, leaving total stale.
      const totalBalance = total + transfer;
      const allocatedBalance = Math.max(0, allocated);
      const availableBalance = Math.max(0, totalBalance - allocatedBalance);
      result.set(acc.id, { balance: totalBalance, totalBalance, availableBalance, allocatedBalance });
    }
  }
  return result;
}
