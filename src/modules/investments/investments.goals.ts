import { prisma } from '../../shared/db/prisma.js';
import type { CalcMovement, MovementType } from './investments.calc.js';
import { loadMarketData, valuePosition, type ValuablePosition } from './investments.valuation.js';

/**
 * Value of the savings goals that have investment positions linked to them (P21 L4).
 *
 * The value of a goal is the sum of the CURRENT value of its OPEN positions, computed by `valuePosition`, the same
 * function that GET /investments/accounts/:id/positions uses (no second rule). It is calculated on read and never
 * written to savings_goals.current_amount. A closed position does not count. A goal with no open linked position is not
 * in the result: it keeps working with its own kept amount.
 *
 * Batch: one query of positions, one of movements, one of quotes and one of rates for ALL the goals asked.
 */

interface DecimalLike {
  toNumber(): number;
}
interface LinkedPosition extends ValuablePosition {
  id: string;
  savingsGoalId: string | null;
}
interface MovementRow {
  id: string;
  positionId: string;
  type: MovementType;
  date: Date;
  quantity: DecimalLike | null;
  amount: DecimalLike;
  createdAt: Date;
}

export interface GoalPositionsValue {
  valueCents: number;
  /** Open positions linked to the goal. */
  positionsCount: number;
  /** The oldest day the values refer to (the quote of the least recent stock); null when no position has one. */
  valueDate: string | null;
  /** Some position is an estimate (fixed income) or has no quote. */
  estimated: boolean;
  noQuote: boolean;
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);
const todayDay = (): string => new Date().toISOString().slice(0, 10);

const calcOf = (m: MovementRow): CalcMovement => ({
  id: m.id,
  type: m.type,
  date: dayOf(m.date),
  createdAt: m.createdAt,
  quantity: m.quantity ? m.quantity.toNumber() : null,
  amountCents: Math.round(m.amount.toNumber() * 100),
});

export async function loadGoalPositionValues(goalIds: readonly string[], asOf: string = todayDay()): Promise<Map<string, GoalPositionsValue>> {
  const out = new Map<string, GoalPositionsValue>();
  if (goalIds.length === 0) return out;

  const positions = (await prisma.investmentPosition.findMany({
    where: { savingsGoalId: { in: [...goalIds] }, closedAt: null },
  })) as unknown as LinkedPosition[];
  const open = positions.filter((p) => p.closedAt === null && p.savingsGoalId !== null);
  if (open.length === 0) return out;

  const movements = (await prisma.investmentMovement.findMany({
    where: { positionId: { in: open.map((p) => p.id) } },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  })) as unknown as MovementRow[];
  const byPosition = new Map<string, CalcMovement[]>();
  for (const m of movements) byPosition.set(m.positionId, [...(byPosition.get(m.positionId) ?? []), calcOf(m)]);

  const market = await loadMarketData(open, asOf);
  for (const p of open) {
    const v = valuePosition(p, byPosition.get(p.id) ?? [], market, asOf);
    const goalId = p.savingsGoalId!;
    const acc = out.get(goalId) ?? { valueCents: 0, positionsCount: 0, valueDate: null, estimated: false, noQuote: false };
    acc.valueCents += v.valueCents;
    acc.positionsCount += 1;
    acc.estimated = acc.estimated || v.estimated || v.noQuote;
    acc.noQuote = acc.noQuote || v.noQuote;
    if (v.valueDate !== null && (acc.valueDate === null || v.valueDate < acc.valueDate)) acc.valueDate = v.valueDate;
    out.set(goalId, acc);
  }
  return out;
}

/** Which of these goals have at least one open position linked: those take their value from the positions. */
export async function goalIdsWithOpenPositions(goalIds: readonly string[], db: Pick<typeof prisma, 'investmentPosition'> = prisma): Promise<Set<string>> {
  if (goalIds.length === 0) return new Set();
  const rows = (await db.investmentPosition.findMany({
    where: { savingsGoalId: { in: [...goalIds] }, closedAt: null },
    select: { savingsGoalId: true },
    distinct: ['savingsGoalId'],
  })) as Array<{ savingsGoalId: string | null }>;
  return new Set(rows.flatMap((r) => (r.savingsGoalId ? [r.savingsGoalId] : [])));
}
