import type { Prisma } from '../../generated/prisma/client.js';
import { CategoryType, GENERAL_BUDGET_CATEGORY } from '../../shared/enums/index.js';
import { deductionCents, type TheirShare } from '../people/own-share.js';
import { notInvoicePaymentWhere } from '../transactions/invoice-payment-link.js';

/**
 * The ONE definition of "what counts as the realized amount of a budget", shared by the budget summary (what the
 * screens show) and by the budget alerts (the notifications), so that an alert never disagrees with the screen.
 *
 * A budget counts the transactions of its household, of its own type (an income filed under an expense category, such
 * as a refund, or a transfer, is not spending) and of its category; the "General" budget takes every category.
 * `periodWhere` is the period filter (see monthOrRangeWhere): the planning month, or a date range.
 *
 * A refund (INCOME row with `isRefund`) cancels an expense, so it is not income: it counts in the budgets and in the
 * dashboard as a negative expense of its own category, and a category may be negative in a month (the refund of a
 * purchase of an earlier month). An income budget never takes a refund.
 *
 * The payment of a card invoice (see invoice-payment-link.ts) is left out: the purchases of the
 * card already count on their own dates, so the payment would count the same money twice.
 */
export const NOT_INVOICE_PAYMENT = notInvoicePaymentWhere();

export function budgetSpendingWhere(
  budget: { householdId: string | undefined; categoryName: string; type: string },
  periodWhere: Record<string, unknown>,
): Prisma.TransactionWhereInput {
  const { AND: periodAnd, ...period } = periodWhere as { AND?: unknown };
  const periodConditions = periodAnd === undefined ? [] : Array.isArray(periodAnd) ? periodAnd : [periodAnd];
  const isExpense = budget.type === CategoryType.EXPENSE;
  // An expense budget takes the expenses and the refunds; an income budget takes the income that is not a refund
  const typeConditions = isExpense
    ? [{ OR: [{ type: CategoryType.EXPENSE }, { type: CategoryType.INCOME, isRefund: true }] }]
    : [{ type: budget.type as CategoryType }, { NOT: { isRefund: true } }];
  return {
    householdId: budget.householdId,
    ...(budget.categoryName === GENERAL_BUDGET_CATEGORY ? {} : { categoryName: budget.categoryName }),
    ...period,
    AND: [...periodConditions, ...typeConditions, NOT_INVOICE_PAYMENT],
  } as Prisma.TransactionWhereInput;
}

/** A row that cancels an expense: income marked as a refund. */
export function isRefundRow(row: { type: string; isRefund?: boolean | null }): boolean {
  return row.type === 'INCOME' && row.isRefund === true;
}

type AmountRow = { type: string; isRefund?: boolean | null; amount: { toNumber(): number } | number };
const amountOf = (row: AmountRow): number => (typeof row.amount === 'number' ? row.amount : row.amount.toNumber());

/** What a row adds to the expense of the month, in reais: its amount for an expense, minus it for a refund, else 0. */
export function expenseDelta(row: AmountRow): number {
  if (row.type === 'EXPENSE') return Math.abs(amountOf(row));
  return isRefundRow(row) ? -Math.abs(amountOf(row)) : 0;
}

/** What a row adds to the income of the month, in reais: income that is not a refund. */
export function incomeDelta(row: AmountRow): number {
  if (row.type !== 'INCOME' || row.isRefund === true) return 0;
  return amountOf(row);
}

/** Sum of the amounts, in reais, added in whole cents: the absolute value of each row, minus it for a refund. */
export function sumSpending(rows: ReadonlyArray<{ amount: { toNumber(): number }; isRefund?: boolean | null }>): number {
  return rows.reduce((cents, row) => {
    const abs = Math.round(Math.abs(row.amount.toNumber()) * 100);
    return row.isRefund === true ? cents - abs : cents + abs;
  }, 0) / 100;
}

/** How a budget is measured: the full spending (a budget kept together) or the own share (kept separately). */
export type BudgetMeasure = 'WHOLE' | 'OWN_SHARE';
export const BUDGET_MEASURES: readonly BudgetMeasure[] = ['WHOLE', 'OWN_SHARE'];

/** The stored mode of a budget; a row without it (older data) is measured as WHOLE. */
export function measureOf(budget: { measure?: string | null }): BudgetMeasure {
  return budget.measure === 'OWN_SHARE' ? 'OWN_SHARE' : 'WHOLE';
}

/**
 * Own share of the spending of a budget: the spending minus what other people owe on its expenses (the shares of its
 * category; of every category for the General budget). Expense budgets only. A refund divided with someone counts the other way, and the result may be negative.
 */
export function ownSpentOf(budget: { categoryName: string; type: string }, spending: number, theirShares: readonly TheirShare[]): number {
  if (budget.type !== 'EXPENSE') return spending;
  const sharedCents = theirShares
    .filter((share) => budget.categoryName === GENERAL_BUDGET_CATEGORY || share.categoryName === budget.categoryName)
    // A refund divided with someone gives back that part: it counts the other way
    .reduce((sum, share) => sum + (share.isRefund ? -1 : 1) * deductionCents(share), 0);
  // No floor: with refunds the own spending of a category can be negative in a month
  return sharedCents === 0 ? spending : (Math.round(spending * 100) - sharedCents) / 100;
}

/**
 * The amount the limit is compared with (percentage, remaining, over-budget flag and alerts): the own share for an
 * expense budget measured separately, the full spending otherwise.
 */
export function measuredAmount(budget: { type: string; measure?: string | null }, spending: number, ownSpent: number): number {
  return budget.type === 'EXPENSE' && measureOf(budget) === 'OWN_SHARE' ? ownSpent : spending;
}
