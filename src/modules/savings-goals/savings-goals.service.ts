import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { NotFoundError, BadRequestError } from '../../shared/errors/index.js';
import type {
  CreateSavingsGoalInput,
  UpdateSavingsGoalInput,
  AddToSavingsGoalInput,
  ListSavingsGoalsQuery,
} from './savings-goals.schema.js';
import { allocatedCentsByAccount, plannedCentsFor } from './savings-goals.planning.js';
import { assertNoLinkedPositions, planGoalOf, toCents, type GoalRow } from './savings-goals.contributions.js';
import { goalIdsWithOpenPositions, loadGoalPositionValues, type GoalPositionsValue } from '../investments/investments.goals.js';

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/** The plan fields of a goal, as the rules below read them. */
interface PlanState {
  kind: 'RESERVE' | 'PROVISION';
  accountId: string | null;
  monthlyContribution: number | null;
  contributionDay: number | null;
  dueMonth: string | null;
}

/** Cross-field rules of the planned contribution, checked on the resulting state (so partial updates cannot break them). */
export function assertPlanConsistent(s: PlanState): void {
  if (s.kind === 'PROVISION') {
    if (!s.dueMonth) throw new BadRequestError('A provision needs the month it is due (dueMonth)');
    if (!s.accountId) throw new BadRequestError('A provision needs the account the money is kept in');
    if (s.contributionDay === null) throw new BadRequestError('A provision needs the day of the month to put money aside (contributionDay)');
  } else if (s.dueMonth) {
    throw new BadRequestError('dueMonth is only for provisions');
  }
  if (s.monthlyContribution !== null) {
    if (!s.accountId) throw new BadRequestError('A monthly contribution needs the account the money is kept in');
    if (s.contributionDay === null) throw new BadRequestError('A monthly contribution needs the day of the month (contributionDay)');
  }
}

type GoalWithPlan = GoalRow & {
  householdId: string;
  targetDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Where this month's planned contribution stands: nothing planned, pending (plan, none made) or done (one or more made). */
export interface ThisMonth {
  month: string;
  status: 'none' | 'pending' | 'done';
  /** 'YYYY-MM-DD' contribution day of the month; null when no day. */
  date: string | null;
  /** What is still planned for the month (0 when done or nothing planned). */
  plannedAmount: number;
  /** What was put in this month. */
  contributedAmount: number;
}

export function thisMonthOf(goal: GoalRow, month: string, contributedCents: number, contributions: number, fromPositions = false): ThisMonth {
  const plan = planGoalOf(goal);
  const date = plan.contributionDay === null ? null : `${month}-${String(plan.contributionDay).padStart(2, '0')}`;
  if (contributions > 0) return { month, status: 'done', date, plannedAmount: 0, contributedAmount: contributedCents / 100 };
  // A goal worth its positions takes no manual contribution: nothing is planned to put in by hand.
  const planned = !fromPositions && plan.accountId && plan.contributionDay !== null ? plannedCentsFor(plan, month, plan.targetCents - plan.currentCents) : 0;
  return { month, status: planned > 0 ? 'pending' : 'none', date, plannedAmount: planned / 100, contributedAmount: 0 };
}

/**
 * JSON shape of a goal: Decimals as numbers, plus progress.
 *
 * With `positions` (open investment positions linked, P21 L4) the current amount is their value (calculated on read, the
 * stored `current_amount` is left alone and hidden): `remaining` never goes below zero and `percentage` is NOT capped,
 * since the market can take the goal past its target (the screen clamps the bar). Without it, nothing changes.
 */
export function serializeGoal(goal: GoalWithPlan & Record<string, unknown>, positions: GoalPositionsValue | null = null) {
  const target = goal.targetAmount.toNumber();
  const current = positions ? positions.valueCents / 100 : goal.currentAmount.toNumber();
  const percentage = target > 0 ? (current / target) * 100 : 0;
  return {
    ...goal,
    targetAmount: target,
    currentAmount: current,
    monthlyContribution: goal.monthlyContribution ? goal.monthlyContribution.toNumber() : null,
    remaining: positions ? Math.max(0, toCents(target) - positions.valueCents) / 100 : target - current,
    percentage: Math.round(percentage * 100) / 100,
    isCompleted: current >= target,
    fromPositions: positions !== null,
    positionsCount: positions?.positionsCount ?? 0,
    valueDate: positions?.valueDate ?? null,
    estimated: positions?.estimated ?? false,
    noQuote: positions?.noQuote ?? false,
  };
}

async function assertAccountOfHousehold(accountId: string, householdId: string) {
  const account = await prisma.account.findFirst({ where: { id: accountId, householdId, isActive: true } });
  if (!account) throw new NotFoundError('Account');
}

/**
 * Create a new savings goal
 */
export async function createSavingsGoal(input: CreateSavingsGoalInput) {
  // householdId must be provided (resolved in routes via ensurePersonalHousehold)
  if (!input.householdId) {
    throw new BadRequestError('householdId is required');
  }
  const householdId = input.householdId;

  const { name, targetAmount, currentAmount, targetDate } = input;

  // Verify current amount doesn't exceed target
  if (currentAmount > targetAmount) {
    throw new BadRequestError('Current amount cannot exceed target amount');
  }

  assertPlanConsistent({
    kind: input.kind ?? 'RESERVE',
    accountId: input.accountId ?? null,
    monthlyContribution: input.monthlyContribution ?? null,
    contributionDay: input.contributionDay ?? null,
    dueMonth: input.dueMonth ?? null,
  });

  // Verify account if provided
  if (input.accountId) {
    await assertAccountOfHousehold(input.accountId, householdId);
  }

  const goal = await prisma.savingsGoal.create({
    data: {
      householdId,
      accountId: input.accountId,
      name,
      targetAmount: new Prisma.Decimal(targetAmount),
      currentAmount: new Prisma.Decimal(currentAmount),
      targetDate,
      kind: input.kind ?? 'RESERVE',
      monthlyContribution: input.monthlyContribution !== undefined ? new Prisma.Decimal(input.monthlyContribution) : null,
      contributionDay: input.contributionDay ?? null,
      dueMonth: input.dueMonth ?? null,
    },
  });

  return serializeGoal(goal as never);
}

/**
 * Get savings goal by ID
 */
export async function getSavingsGoal(goalId: string, opts: { valued?: boolean } = {}) {
  const goal = await prisma.savingsGoal.findUnique({
    where: { id: goalId },
  });

  if (!goal) {
    throw new NotFoundError('Savings goal');
  }

  // `valued: false` is for the routes that only need the household (permission check): no position is read
  if (opts.valued === false) return serializeGoal(goal as never);
  return serializeGoal(goal as never, (await loadGoalPositionValues([goal.id])).get(goal.id) ?? null);
}

/**
 * List savings goals for a household. Each goal carries `thisMonth`: where its planned contribution of the current
 * month stands (nothing planned, pending, done).
 */
export async function listSavingsGoals(query: ListSavingsGoalsQuery & { today?: Date }) {
  const { householdId } = query;
  const month = dayOf(query.today ?? new Date()).slice(0, 7);

  const goals = await prisma.savingsGoal.findMany({
    where: { householdId },
    orderBy: [
      { createdAt: 'desc' },
    ],
  });
  const monthRows = goals.length === 0 ? [] : await prisma.savingsGoalContribution.findMany({
    where: { householdId, month, goalId: { in: goals.map((g) => g.id) } },
    select: { goalId: true, amount: true },
  });
  const inMonth = new Map<string, { cents: number; count: number }>();
  for (const r of monthRows) {
    const e = inMonth.get(r.goalId) ?? { cents: 0, count: 0 };
    e.cents += toCents(r.amount.toNumber());
    e.count += 1;
    inMonth.set(r.goalId, e);
  }

  const values = await loadGoalPositionValues(goals.map((g) => g.id));

  return goals.map((goal) => {
    const e = inMonth.get(goal.id);
    const positions = values.get(goal.id) ?? null;
    return { ...serializeGoal(goal as never, positions), thisMonth: thisMonthOf(goal as unknown as GoalRow, month, e?.cents ?? 0, e?.count ?? 0, positions !== null) };
  });
}

/**
 * Per cash/investment account that holds goals: the balance (what matches the statement, never changed by a goal), what
 * the goals keep in it and the free balance (balance minus kept). The kept amount is `allocatedCentsByAccount`, the one
 * definition the cash flow also uses.
 */
export async function savingsSummary(householdId: string) {
  const goals = await prisma.savingsGoal.findMany({ where: { householdId, accountId: { not: null } } });
  // A goal worth its investment positions marks no money inside an account balance: its value lives in the positions
  const withPositions = await goalIdsWithOpenPositions(goals.map((g) => g.id));
  const kept = allocatedCentsByAccount(goals.filter((g) => !withPositions.has(g.id)).map((g) => planGoalOf(g as unknown as GoalRow)));
  if (kept.size === 0) return { accounts: [] as Array<Record<string, unknown>>, totalAllocated: 0 };
  const accounts = await prisma.account.findMany({ where: { householdId, id: { in: [...kept.keys()] } }, orderBy: { name: 'asc' } });
  const rows = accounts.map((a) => {
    const allocatedCents = kept.get(a.id) ?? 0;
    const balanceCents = toCents(a.balance.toNumber());
    return {
      accountId: a.id,
      name: a.name,
      type: a.type,
      balance: balanceCents / 100,
      allocated: allocatedCents / 100,
      free: (balanceCents - allocatedCents) / 100,
    };
  });
  return { accounts: rows, totalAllocated: rows.reduce((s, r) => s + toCents(r.allocated), 0) / 100 };
}

/**
 * Update savings goal
 */
export async function updateSavingsGoal(goalId: string, input: UpdateSavingsGoalInput) {
  const existingGoal = await prisma.savingsGoal.findUnique({
    where: { id: goalId },
  });

  if (!existingGoal) {
    throw new NotFoundError('Savings goal');
  }

  // A goal worth its positions has no current amount to edit, and the stored one (hidden) is not checked against the target
  const fromPositions = (await goalIdsWithOpenPositions([goalId])).size > 0;
  if (fromPositions && input.currentAmount !== undefined) await assertNoLinkedPositions(prisma, goalId);

  // Validate current amount doesn't exceed new target if both are being updated
  const newCurrentAmount = input.currentAmount ?? existingGoal.currentAmount.toNumber();
  const newTargetAmount = input.targetAmount ?? existingGoal.targetAmount.toNumber();

  if (!fromPositions && newCurrentAmount > newTargetAmount) {
    throw new BadRequestError('Current amount cannot exceed target amount');
  }

  // Resulting plan state: what is sent wins, the rest stays
  const next: PlanState = {
    kind: input.kind ?? existingGoal.kind,
    accountId: input.accountId !== undefined ? input.accountId : existingGoal.accountId,
    monthlyContribution: input.monthlyContribution !== undefined ? input.monthlyContribution : existingGoal.monthlyContribution?.toNumber() ?? null,
    contributionDay: input.contributionDay !== undefined ? input.contributionDay : existingGoal.contributionDay,
    dueMonth: input.dueMonth !== undefined ? input.dueMonth : existingGoal.dueMonth,
  };
  // Back to a reserve: the due month goes with the provision
  if (input.kind === 'RESERVE' && input.dueMonth === undefined) next.dueMonth = null;
  assertPlanConsistent(next);

  // Verify account if provided
  if (input.accountId) {
    await assertAccountOfHousehold(input.accountId, existingGoal.householdId);
  }

  const goal = await prisma.savingsGoal.update({
    where: { id: goalId },
    data: {
      ...(input.accountId !== undefined && { accountId: input.accountId }),
      ...(input.name !== undefined && { name: input.name }),
      ...(input.targetAmount !== undefined && {
        targetAmount: new Prisma.Decimal(input.targetAmount),
      }),
      ...(input.currentAmount !== undefined && {
        currentAmount: new Prisma.Decimal(input.currentAmount),
      }),
      ...(input.targetDate !== undefined && { targetDate: input.targetDate }),
      ...(input.kind !== undefined && { kind: input.kind }),
      ...(input.monthlyContribution !== undefined && {
        monthlyContribution: input.monthlyContribution === null ? null : new Prisma.Decimal(input.monthlyContribution),
      }),
      ...(input.contributionDay !== undefined && { contributionDay: input.contributionDay }),
      dueMonth: next.dueMonth,
    },
  });

  return serializeGoal(goal as never, (await loadGoalPositionValues([goalId])).get(goalId) ?? null);
}

/**
 * Add amount to savings goal
 */
export async function addToSavingsGoal(
  goalId: string,
  householdId: string,
  input: AddToSavingsGoalInput
) {
  const goal = await prisma.savingsGoal.findFirst({
    where: { id: goalId, householdId },
  });

  if (!goal) {
    throw new NotFoundError('Savings goal');
  }
  await assertNoLinkedPositions(prisma, goalId);

  const newAmount = goal.currentAmount.toNumber() + input.amount;
  const target = goal.targetAmount.toNumber();

  if (newAmount > target) {
    throw new BadRequestError(
      `Adding this amount would exceed the target. Maximum allowed: ${target - goal.currentAmount.toNumber()}`
    );
  }

  const updatedGoal = await prisma.savingsGoal.update({
    where: { id: goalId },
    data: {
      currentAmount: new Prisma.Decimal(newAmount),
    },
  });

  return updatedGoal;
}

/**
 * Delete savings goal
 */
export async function deleteSavingsGoal(goalId: string) {
  const goal = await prisma.savingsGoal.findUnique({
    where: { id: goalId },
  });

  if (!goal) {
    throw new NotFoundError('Savings goal');
  }

  await prisma.savingsGoal.delete({
    where: { id: goalId },
  });

  return { deleted: true };
}
