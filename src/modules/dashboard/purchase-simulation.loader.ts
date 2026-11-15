import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError, NotFoundError } from '../../shared/errors/index.js';
import { addMonths, effectiveMonth, effectiveMonthRangeWhere, monthDistance } from '../../shared/utils/competence.js';
import { effectiveClosingDay } from '../accounts/closing-day.js';
import { NOT_INVOICE_PAYMENT } from '../budgets/budget-spending.js';
import { dayString } from '../recurring-transactions/recurring-dates.js';
import { expectedIncomeByMonth } from '../transactions/credit-card-commitment.js';
import { utcToday } from '../transactions/transactions.service.js';
import { recurrenceEvents } from './cash-flow.loader.js';
import { AVERAGE_MONTHS, buildPurchaseSimulation, splitInstallmentCents, type PurchaseSimulation } from './purchase-simulation.js';

/** How far ahead (months from today) the first installment may be. */
const MAX_FIRST_MONTH_AHEAD = 24;
const cents = (amount: { toNumber(): number }): number => Math.round(Math.abs(amount.toNumber()) * 100);

export interface PurchaseSimulationParams {
  householdId: string;
  /** In reais, at most 2 decimals. */
  totalAmount: number;
  installments: number;
  /** 'YYYY-MM'; by default the month the closing day of the chosen card puts the first installment in. */
  firstMonth?: string;
  accountId?: string;
  categoryName?: string;
  today?: Date;
}

/** Last day of a 'YYYY-MM' month, 'YYYY-MM-DD'. */
function lastDayOf(month: string): string {
  return dayString(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)));
}

function add(map: Map<string, Map<string, number>>, month: string, category: string, value: number): void {
  const inner = map.get(month) ?? new Map<string, number>();
  inner.set(category, (inner.get(category) ?? 0) + value);
  map.set(month, inner);
}

/**
 * POST /dashboard/purchase-simulation: how the coming months look if a purchase were made in N installments. Reads only,
 * nothing is saved. The month rule is the one of the dashboard and the budgets: the planning month (`effectiveMonth`),
 * with the payment of a card invoice left out (NOT_INVOICE_PAYMENT), so the figures match the dashboard in the months
 * they share. Committed = what is already posted in the month (installments, bills, purchases) + what the recurrences
 * have not generated yet (the cash-flow walk, which skips a month the recurrence already holds a row in, so it is never
 * counted twice). Income = the expected income of the month, the same estimate the income split uses; it is an estimate.
 */
export async function loadPurchaseSimulation(params: PurchaseSimulationParams): Promise<PurchaseSimulation> {
  const { householdId, totalAmount, installments } = params;
  const today = dayString(params.today ?? utcToday());
  const currentMonth = today.slice(0, 7);
  const parts = splitInstallmentCents(Math.round(totalAmount * 100), installments);

  let accountClosing: number | null = null;
  if (params.accountId) {
    const account = await prisma.account.findFirst({ where: { id: params.accountId, householdId } });
    if (!account) throw new NotFoundError('Account not found');
    if (account.type === 'CREDIT') accountClosing = effectiveClosingDay(account);
  }
  // A card purchase on or after the closing day goes to the next invoice (like the installment screen does)
  const defaultFirst = accountClosing !== null && Number(today.slice(8, 10)) >= accountClosing ? addMonths(currentMonth, 1) : currentMonth;
  const firstMonth = params.firstMonth ?? defaultFirst;
  if (firstMonth < currentMonth) throw new BadRequestError('The first installment cannot be in a past month');
  if (monthDistance(currentMonth, firstMonth) > MAX_FIRST_MONTH_AHEAD) throw new BadRequestError(`The first installment is too far ahead (at most ${MAX_FIRST_MONTH_AHEAD} months)`);

  const lastMonth = addMonths(firstMonth, installments - 1);
  const months = Array.from({ length: monthDistance(currentMonth, lastMonth) + 1 }, (_, i) => addMonths(currentMonth, i));
  const averageFrom = addMonths(currentMonth, -AVERAGE_MONTHS);
  const averageTo = addMonths(currentMonth, -1);

  const [rows, accounts, income, budgets] = await Promise.all([
    prisma.transaction.findMany({
      where: { householdId, type: 'EXPENSE', AND: [effectiveMonthRangeWhere(averageFrom, lastMonth), NOT_INVOICE_PAYMENT] },
      select: { amount: true, categoryName: true, date: true, competenceMonth: true },
    }),
    prisma.account.findMany({ where: { householdId, isActive: true }, select: { id: true } }),
    expectedIncomeByMonth(householdId, months),
    prisma.budget.findMany({ where: { householdId, type: 'EXPENSE' } }),
  ]);

  const postedByMonth = new Map<string, Map<string, number>>();
  let averageTotalCents = 0;
  for (const row of rows) {
    const month = effectiveMonth(row);
    const value = cents(row.amount);
    if (month >= averageFrom && month <= averageTo) averageTotalCents += value;
    if (months.includes(month)) add(postedByMonth, month, row.categoryName ?? '', value);
  }

  // What the recurrences have not generated yet, from today to the last month shown
  const forecastByMonth = new Map<string, Map<string, number>>();
  if (accounts.length > 0) {
    const events = (await recurrenceEvents(householdId, accounts.map((a) => a.id), today, lastDayOf(lastMonth))).filter((e) => e.amountCents < 0 && months.includes(e.date.slice(0, 7)));
    if (events.length > 0) {
      const recurrences = await prisma.recurringTransaction.findMany({ where: { householdId, id: { in: [...new Set(events.map((e) => e.sourceId))] } }, select: { id: true, categoryName: true } });
      const categoryOf = new Map(recurrences.map((r) => [r.id, r.categoryName]));
      for (const e of events) if (categoryOf.has(e.sourceId)) add(forecastByMonth, e.date.slice(0, 7), categoryOf.get(e.sourceId) ?? '', -e.amountCents);
    }
  }

  return buildPurchaseSimulation({
    months,
    firstMonth,
    installmentCents: parts,
    postedByMonth,
    forecastByMonth,
    incomeByMonth: income,
    budgets: budgets.map((b) => ({ categoryName: b.categoryName, type: b.type, month: b.month, endMonth: b.endMonth, limitCents: Math.round(b.monthlyLimit.toNumber() * 100) })),
    categoryName: params.categoryName,
    averageTotalCents,
  });
}
