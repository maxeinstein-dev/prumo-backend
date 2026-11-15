import { BadRequestError } from '../../shared/errors/app-error.js';
import { GENERAL_BUDGET_CATEGORY } from '../../shared/enums/index.js';
import { addMonths } from '../../shared/utils/competence.js';
import { pickEffectiveBudgets } from '../budgets/budget-effective.js';

/** Most installments a simulated purchase may have. */
export const MAX_SIMULATED_INSTALLMENTS = 24;
/** How many months the average of the past expenses looks at (the months before the current one). */
export const AVERAGE_MONTHS = 6;

/**
 * Splits a purchase in whole cents: the parts add up to the total and the cents the division leaves go one each to the
 * first parts (100.00 in 3 = 33.34 + 33.33 + 33.33). Every part is at least one cent.
 * @throws BadRequestError
 */
export function splitInstallmentCents(totalCents: number, installments: number): number[] {
  if (!Number.isInteger(totalCents) || totalCents <= 0) throw new BadRequestError('The purchase amount must be a positive value in whole cents');
  if (!Number.isInteger(installments) || installments < 1 || installments > MAX_SIMULATED_INSTALLMENTS) {
    throw new BadRequestError(`The number of installments must be between 1 and ${MAX_SIMULATED_INSTALLMENTS}`);
  }
  const base = Math.floor(totalCents / installments);
  if (base < 1) throw new BadRequestError('The amount is too small for that many installments');
  const extra = totalCents - base * installments;
  return Array.from({ length: installments }, (_, i) => base + (i < extra ? 1 : 0));
}

/** The months of the installments, one per month from `firstMonth` ('YYYY-MM'). */
export function installmentMonths(firstMonth: string, installments: number): string[] {
  return Array.from({ length: installments }, (_, i) => addMonths(firstMonth, i));
}

export interface SimulationBudget {
  categoryName: string;
  type: string;
  month: Date;
  endMonth?: Date | null;
  limitCents: number;
}

export interface SimulationInput {
  /** The months shown, in order: the current month up to the last installment. */
  months: readonly string[];
  firstMonth: string;
  installmentCents: readonly number[];
  /** Expenses already posted, by planning month, then by category (whole cents, positive). */
  postedByMonth: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Expenses the recurrences have not generated yet, by month, then by category (whole cents, positive). */
  forecastByMonth: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Expected income by month (whole cents). */
  incomeByMonth: ReadonlyMap<string, number>;
  budgets: readonly SimulationBudget[];
  /** Category of the purchase, when chosen: its budget is judged too. */
  categoryName?: string;
  /** Total expense of the months of the average (whole cents). */
  averageTotalCents: number;
}

export interface SimulationMonth {
  month: string;
  committed: number;
  committedPosted: number;
  committedForecast: number;
  postedByCategory: Record<string, number>;
  newInstallment: number;
  total: number;
  expectedIncome: number;
  leftover: number;
  leftoverWithoutPurchase: number;
}

export interface BudgetOverrun {
  month: string;
  scope: 'GENERAL' | 'CATEGORY';
  categoryName: string;
  limit: number;
  projected: number;
  withoutPurchase: number;
}

export interface PurchaseSimulation {
  firstMonth: string;
  /** The installments, in reais, first to last. */
  installments: number[];
  months: SimulationMonth[];
  hasExpectedIncome: boolean;
  /** The month with the smallest leftover among the ones that hold an installment. */
  tightest: { month: string; leftover: number; leftoverWithoutPurchase: number } | null;
  /** Months with an installment where the purchase takes a budget above its limit. */
  budgetOverruns: BudgetOverrun[];
  averageExpense: { months: number; amount: number };
}

const sumOf = (m: ReadonlyMap<string, number> | undefined): number => {
  let total = 0;
  for (const v of m?.values() ?? []) total += v;
  return total;
};
const reais = (cents: number): number => cents / 100;

/** Pure: the simulation from the already loaded figures. All sums are in whole cents until the very end. */
export function buildPurchaseSimulation(input: SimulationInput): PurchaseSimulation {
  const installmentOf = new Map(installmentMonths(input.firstMonth, input.installmentCents.length).map((m, i) => [m, input.installmentCents[i]!]));
  const months: SimulationMonth[] = [];
  const budgetOverruns: BudgetOverrun[] = [];

  for (const month of input.months) {
    const posted = sumOf(input.postedByMonth.get(month));
    const forecast = sumOf(input.forecastByMonth.get(month));
    const installment = installmentOf.get(month) ?? 0;
    const income = input.incomeByMonth.get(month) ?? 0;
    const committed = posted + forecast;
    months.push({
      month,
      committed: reais(committed),
      committedPosted: reais(posted),
      committedForecast: reais(forecast),
      postedByCategory: Object.fromEntries([...(input.postedByMonth.get(month) ?? [])].filter(([, v]) => v > 0).map(([k, v]) => [k, reais(v)])),
      newInstallment: reais(installment),
      total: reais(committed + installment),
      expectedIncome: reais(income),
      leftover: reais(income - committed - installment),
      leftoverWithoutPurchase: reais(income - committed),
    });

    if (installment === 0) continue;
    const inForce = pickEffectiveBudgets(input.budgets.filter((b) => b.type === 'EXPENSE'), month);
    const general = inForce.find((b) => b.categoryName === GENERAL_BUDGET_CATEGORY);
    if (general && committed + installment > general.limitCents) {
      budgetOverruns.push({ month, scope: 'GENERAL', categoryName: GENERAL_BUDGET_CATEGORY, limit: reais(general.limitCents), projected: reais(committed + installment), withoutPurchase: reais(committed) });
    }
    const own = input.categoryName ? inForce.find((b) => b.categoryName === input.categoryName) : undefined;
    if (own) {
      const base = (input.postedByMonth.get(month)?.get(own.categoryName) ?? 0) + (input.forecastByMonth.get(month)?.get(own.categoryName) ?? 0);
      if (base + installment > own.limitCents) {
        budgetOverruns.push({ month, scope: 'CATEGORY', categoryName: own.categoryName, limit: reais(own.limitCents), projected: reais(base + installment), withoutPurchase: reais(base) });
      }
    }
  }

  const withInstallment = months.filter((m) => m.newInstallment > 0);
  const tightest = withInstallment.reduce<SimulationMonth | null>((min, m) => (min === null || m.leftover < min.leftover ? m : min), null);
  return {
    firstMonth: input.firstMonth,
    installments: input.installmentCents.map(reais),
    months,
    hasExpectedIncome: months.some((m) => m.expectedIncome > 0),
    tightest: tightest && { month: tightest.month, leftover: tightest.leftover, leftoverWithoutPurchase: tightest.leftoverWithoutPurchase },
    budgetOverruns,
    averageExpense: { months: AVERAGE_MONTHS, amount: reais(Math.round(input.averageTotalCents / AVERAGE_MONTHS)) },
  };
}
