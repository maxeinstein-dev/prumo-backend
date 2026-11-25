import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors/index.js';
import { AccountType } from '../../shared/enums/index.js';
import {
  cashEffectCents,
  computePosition,
  deriveAmounts,
  incomeLast12MonthsCents,
  sortMovements,
  type CalcMovement,
  type MovementType,
  type PositionKind,
} from './investments.calc.js';
import { loadMarketData, valuePosition, type MarketData } from './investments.valuation.js';
import type { CreateMovementInput, CreatePositionInput, UpdatePositionInput } from './investments.schema.js';

/**
 * Investment positions inside an INVESTMENT account (P21 L1).
 *
 * A movement is a record of its own. It NEVER creates a Transaction and NEVER changes accounts.balance: the aporte is a
 * transfer (already in the balance), a BUY consumes that balance only in the calculation below, and an INCOME is not
 * the revenue of the month. See investments.no-double-count.test.ts, which pins this in the source.
 *
 * Money is integer cents in every sum; the API speaks reais (numbers with at most two decimals), like the rest of Recta.
 */

type Db = Prisma.TransactionClient;
interface AccountRow {
  id: string;
  householdId: string;
  name: string;
  type: string;
  isActive: boolean;
  balance: { toNumber(): number };
}
interface DecimalLike {
  toNumber(): number;
}
interface PositionRow {
  id: string;
  householdId: string;
  accountId: string;
  kind: PositionKind;
  ticker: string | null;
  name: string;
  savingsGoalId: string | null;
  indexer: string | null;
  rate: DecimalLike | null;
  maturityDate: Date | null;
  anchorAmount: DecimalLike | null;
  anchorDate: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  account: AccountRow;
}
interface MovementRow {
  id: string;
  positionId: string;
  type: MovementType;
  date: Date;
  quantity: DecimalLike | null;
  unitPrice: DecimalLike | null;
  amount: DecimalLike;
  notes: string | null;
  sourceRef: string | null;
  createdAt: Date;
}

const cents = (d: DecimalLike): number => Math.round(d.toNumber() * 100);
const reais = (c: number): number => c / 100;
const dayOf = (d: Date): string => d.toISOString().slice(0, 10);
const todayDay = (): string => new Date().toISOString().slice(0, 10);
const asDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
const fromCents = (c: number): Prisma.Decimal => new Prisma.Decimal(c).div(100);

const calcOf = (m: MovementRow): CalcMovement => ({
  id: m.id,
  type: m.type,
  date: dayOf(m.date),
  createdAt: m.createdAt,
  quantity: m.quantity ? m.quantity.toNumber() : null,
  amountCents: cents(m.amount),
});

// ---------------------------------------------------------------------------------------------------------- loading

export async function loadAccount(accountId: string): Promise<AccountRow> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, householdId: true, name: true, type: true, isActive: true, balance: true },
  });
  if (!account) throw new NotFoundError('Account');
  return account as AccountRow;
}

export async function loadPosition(positionId: string): Promise<PositionRow> {
  const position = await prisma.investmentPosition.findUnique({ where: { id: positionId }, include: { account: true } });
  if (!position) throw new NotFoundError('Position');
  return position as unknown as PositionRow;
}

function assertInvestmentAccount(account: AccountRow, write: boolean): void {
  if (account.type !== AccountType.INVESTMENT) throw new BadRequestError('Only an investment account holds positions');
  if (write && !account.isActive) throw new BadRequestError('The account is inactive');
}

// ------------------------------------------------------------------------------------------------------------ views

function positionView(p: PositionRow, movements: MovementRow[], today = todayDay()) {
  const calc = movements.map(calcOf);
  const f = computePosition(p.kind, calc);
  return {
    id: p.id,
    accountId: p.accountId,
    savingsGoalId: p.savingsGoalId,
    kind: p.kind,
    ticker: p.ticker,
    name: p.name,
    indexer: p.indexer,
    rate: p.rate ? p.rate.toNumber() : null,
    maturityDate: p.maturityDate ? dayOf(p.maturityDate) : null,
    anchor: p.anchorAmount && p.anchorDate ? { amount: p.anchorAmount.toNumber(), date: dayOf(p.anchorDate) } : null,
    closedAt: p.closedAt ? dayOf(p.closedAt) : null,
    quantity: f.quantity,
    avgPrice: f.avgPrice,
    costAmount: reais(f.costCents),
    incomeLast12Months: reais(incomeLast12MonthsCents(calc, today)),
    createdAt: p.createdAt.toISOString(),
  };
}

function movementView(m: MovementRow) {
  return {
    id: m.id,
    positionId: m.positionId,
    type: m.type,
    date: dayOf(m.date),
    quantity: m.quantity ? m.quantity.toNumber() : null,
    unitPrice: m.unitPrice ? m.unitPrice.toNumber() : null,
    amount: m.amount.toNumber(),
    notes: m.notes,
    sourceRef: m.sourceRef,
    createdAt: m.createdAt.toISOString(),
  };
}

/** The L1 figures of a position plus its current value (P21 L2): value, result, the day it refers to and how sure it is. */
function valuedView(p: PositionRow, movements: MovementRow[], market: MarketData, asOf: string) {
  const v = valuePosition(p, movements.map(calcOf), market, asOf);
  return {
    view: {
      ...positionView(p, movements, asOf),
      currentValue: reais(v.valueCents),
      result: reais(v.valueCents - v.costCents),
      valueDate: v.valueDate,
      valueMark: v.valueMark,
      estimated: v.estimated,
      noQuote: v.noQuote,
      ratesCarried: v.ratesCarried,
      ratesMissing: v.ratesMissing,
      lastQuote: v.lastQuote,
    },
    valuation: v,
  };
}

async function movementsOf(db: Db | typeof prisma, positionId: string): Promise<MovementRow[]> {
  return (await db.investmentMovement.findMany({ where: { positionId }, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] })) as unknown as MovementRow[];
}

async function detail(db: Db | typeof prisma, positionId: string, withValue = false) {
  const p = (await db.investmentPosition.findUnique({ where: { id: positionId }, include: { account: true } })) as unknown as PositionRow;
  const movements = await movementsOf(db, positionId);
  const ordered = sortMovements(movements.map((m) => ({ ...m, date: dayOf(m.date) }))).reverse();
  const asOf = todayDay();
  return {
    ...(withValue ? valuedView(p, movements, await loadMarketData([p], asOf), asOf).view : positionView(p, movements)),
    movements: ordered.map((o) => movementView(movements.find((m) => m.id === o.id)!)),
  };
}

// ----------------------------------------------------------------------------------------------------------- list

/** Positions of an account with their figures, and the account summary: cash at the broker and total at cost. */
export async function listPositions(account: AccountRow, opts: { includeClosed?: boolean; asOf?: string }) {
  assertInvestmentAccount(account, false);
  const positions = (await prisma.investmentPosition.findMany({
    where: { accountId: account.id, ...(opts.includeClosed ? {} : { closedAt: null }) },
    orderBy: [{ createdAt: 'asc' }],
    include: { account: true },
  })) as unknown as PositionRow[];
  // Every movement of the account counts in the cash, closed positions included.
  const all = (await prisma.investmentMovement.findMany({
    where: { position: { accountId: account.id } },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  })) as unknown as MovementRow[];

  const byPosition = new Map<string, MovementRow[]>();
  let cashEffect = 0;
  for (const m of all) {
    cashEffect += cashEffectCents(m.type, cents(m.amount));
    byPosition.set(m.positionId, [...(byPosition.get(m.positionId) ?? []), m]);
  }

  const asOf = opts.asOf ?? todayDay();
  const market = await loadMarketData(positions, asOf);
  const valued = positions.map((p) => valuedView(p, byPosition.get(p.id) ?? [], market, asOf));
  const views = valued.map((v) => v.view);
  const openValued = valued.filter((v) => v.view.closedAt === null);
  const positionsValueCents = openValued.reduce((s, v) => s + v.valuation.valueCents, 0);
  const positionsResultCents = openValued.reduce((s, v) => s + v.valuation.valueCents - v.valuation.costCents, 0);
  const positionsCostCents = views.filter((v) => v.closedAt === null).reduce((s, v) => s + Math.round(v.costAmount * 100), 0);
  const accountBalanceCents = cents(account.balance);
  const cashCents = accountBalanceCents + cashEffect;
  return {
    summary: {
      accountId: account.id,
      accountName: account.name,
      accountBalance: reais(accountBalanceCents),
      cashBalance: reais(cashCents),
      positionsCost: reais(positionsCostCents),
      totalAtCost: reais(positionsCostCents + cashCents),
      // P21 L2: market value. Only added fields; the L1 ones above keep their meaning (at cost).
      valuedAt: asOf,
      positionsValue: reais(positionsValueCents),
      positionsResult: reais(positionsResultCents),
      totalValue: reais(positionsValueCents + cashCents),
      hasEstimates: openValued.some((v) => v.valuation.estimated),
      hasNoQuote: openValued.some((v) => v.valuation.noQuote),
    },
    positions: views,
  };
}

export async function getPositionDetail(position: PositionRow) {
  return detail(prisma, position.id, true);
}

// ------------------------------------------------------------------------------------------------ movement building

interface MovementData {
  type: MovementType;
  date: Date;
  quantity: Prisma.Decimal | null;
  unitPrice: Prisma.Decimal | null;
  amount: Prisma.Decimal;
  notes: string | null;
  sourceRef: string | null;
  calc: CalcMovement;
}

/** Applies the per-kind input rules and turns the client input into stored values plus the entry the calculation reads. */
function buildMovement(kind: PositionKind, input: CreateMovementInput): MovementData {
  const hasMoney = input.amount !== undefined;
  let quantity: number | null = null;
  let unitPrice: number | null = null;
  let amountCents: number;

  if (input.type === 'INCOME' || kind === 'FIXED_INCOME') {
    if (input.quantity !== undefined || input.unitPrice !== undefined) {
      throw new BadRequestError(
        input.type === 'INCOME' ? 'An income carries only the amount' : 'A fixed income movement carries only the amount (no quantity or unit price)',
      );
    }
    if (!hasMoney) throw new BadRequestError('Inform the amount');
    amountCents = Math.round(input.amount! * 100);
  } else {
    if (input.quantity === undefined) throw new BadRequestError('Inform the quantity');
    if (!hasMoney && input.unitPrice === undefined) throw new BadRequestError('Inform the amount or the unit price');
    const derived = deriveAmounts({
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      amountCents: hasMoney ? Math.round(input.amount! * 100) : undefined,
    });
    quantity = input.quantity;
    unitPrice = derived.unitPrice;
    amountCents = derived.amountCents;
    if (amountCents <= 0) throw new BadRequestError('The amount rounds to zero');
  }

  return {
    type: input.type,
    date: asDate(input.date),
    quantity: quantity === null ? null : new Prisma.Decimal(quantity),
    unitPrice: unitPrice === null ? null : new Prisma.Decimal(unitPrice),
    amount: fromCents(amountCents),
    notes: input.notes ?? null,
    sourceRef: input.sourceRef ?? null,
    calc: { type: input.type, date: input.date, createdAt: new Date(), quantity, amountCents },
  };
}

const isUniqueViolation = (e: unknown): boolean => (e as { code?: string } | null)?.code === 'P2002';

async function lockPosition(tx: Db, positionId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM investment_positions WHERE id = ${positionId}::uuid FOR UPDATE`;
}

// ---------------------------------------------------------------------------------------------------------- create

async function assertGoal(householdId: string, goalId: string | null | undefined): Promise<void> {
  if (!goalId) return;
  const goal = await prisma.savingsGoal.findFirst({ where: { id: goalId, householdId }, select: { id: true } });
  if (!goal) throw new NotFoundError('Savings goal');
}

export async function createPosition(account: AccountRow, input: CreatePositionInput) {
  assertInvestmentAccount(account, true);
  const fixed = input.kind === 'FIXED_INCOME';
  if (fixed) {
    if (input.ticker) throw new BadRequestError('A fixed income position has no ticker');
    if (!input.indexer || input.rate === undefined) throw new BadRequestError('A fixed income position needs the indexer and the rate');
  } else {
    if (!input.ticker) throw new BadRequestError('A stock exchange position needs the ticker');
    if (input.indexer || input.rate !== undefined || input.maturityDate || input.anchor) {
      throw new BadRequestError('Indexer, rate, maturity and anchor are for fixed income only');
    }
  }
  await assertGoal(account.householdId, input.savingsGoalId);
  if (input.ticker) {
    const twin = await prisma.investmentPosition.findFirst({
      where: { accountId: account.id, ticker: input.ticker, closedAt: null },
      select: { id: true },
    });
    if (twin) throw new ConflictError('There is already an open position with this ticker in the account');
  }
  const opening = input.opening ? buildMovement(input.kind, { type: 'OPENING', ...input.opening }) : null;

  const id = await prisma.$transaction(async (tx) => {
    const created = await tx.investmentPosition.create({
      data: {
        householdId: account.householdId,
        accountId: account.id,
        kind: input.kind,
        ticker: input.ticker ?? null,
        name: input.name,
        savingsGoalId: input.savingsGoalId ?? null,
        indexer: input.indexer ?? null,
        rate: input.rate === undefined ? null : new Prisma.Decimal(input.rate),
        maturityDate: input.maturityDate ? asDate(input.maturityDate) : null,
        anchorAmount: input.anchor ? new Prisma.Decimal(input.anchor.amount) : null,
        anchorDate: input.anchor ? asDate(input.anchor.date) : null,
      },
    });
    if (opening) {
      const { calc: _calc, ...data } = opening;
      await tx.investmentMovement.create({ data: { ...data, householdId: account.householdId, positionId: created.id } });
    }
    return created.id;
  });
  return detail(prisma, id);
}

// ---------------------------------------------------------------------------------------------------------- update

export async function updatePosition(position: PositionRow, input: UpdatePositionInput) {
  assertInvestmentAccount(position.account, true);
  const fixed = position.kind === 'FIXED_INCOME';
  if (!fixed && (input.indexer || input.rate !== undefined || input.maturityDate !== undefined || input.anchor !== undefined)) {
    throw new BadRequestError('Indexer, rate, maturity and anchor are for fixed income only');
  }
  await assertGoal(position.householdId, input.savingsGoalId);
  // Closing takes the position out of the account's value, so it must be empty first (decided by the user on
  // 25/11/2026): a stock position sold out, a fixed income position fully redeemed. Otherwise it would vanish from the
  // net worth with nothing sold.
  if (input.closed === true && !position.closedAt) {
    const figures = computePosition(position.kind, (await movementsOf(prisma, position.id)).map(calcOf));
    if ((figures.quantity ?? 0) > 0 || figures.costCents > 0) {
      throw new BadRequestError('Sell or redeem the whole position before closing it');
    }
  }

  const data: Prisma.InvestmentPositionUncheckedUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.savingsGoalId !== undefined) data.savingsGoalId = input.savingsGoalId;
  if (input.indexer !== undefined) data.indexer = input.indexer;
  if (input.rate !== undefined) data.rate = new Prisma.Decimal(input.rate);
  if (input.maturityDate !== undefined) data.maturityDate = input.maturityDate ? asDate(input.maturityDate) : null;
  if (input.anchor !== undefined) {
    data.anchorAmount = input.anchor ? new Prisma.Decimal(input.anchor.amount) : null;
    data.anchorDate = input.anchor ? asDate(input.anchor.date) : null;
  }
  if (input.closed !== undefined) data.closedAt = input.closed ? asDate(todayDay()) : null;
  await prisma.investmentPosition.update({ where: { id: position.id }, data });
  return detail(prisma, position.id);
}

// ------------------------------------------------------------------------------------------------------- movements

export async function createMovement(position: PositionRow, input: CreateMovementInput) {
  assertInvestmentAccount(position.account, true);
  if (position.closedAt) throw new BadRequestError('The position is closed');
  const built = buildMovement(position.kind, input);

  try {
    return await prisma.$transaction(async (tx) => {
      await lockPosition(tx, position.id);
      const existing = await movementsOf(tx, position.id);
      // The whole resulting sequence must hold (quantity never negative), also for a back-dated entry.
      computePosition(position.kind, [...existing.map(calcOf), built.calc]);
      const { calc: _calc, ...data } = built;
      const created = (await tx.investmentMovement.create({
        data: { ...data, householdId: position.householdId, positionId: position.id },
      })) as unknown as MovementRow;
      return { movement: movementView(created), position: positionView(position, [...existing, created]) };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError('A movement with this sourceRef already exists');
    throw e;
  }
}

export async function deleteMovement(position: PositionRow, movementId: string) {
  assertInvestmentAccount(position.account, true);
  return prisma.$transaction(async (tx) => {
    await lockPosition(tx, position.id);
    const existing = await movementsOf(tx, position.id);
    if (!existing.some((m) => m.id === movementId)) throw new NotFoundError('Movement');
    const rest = existing.filter((m) => m.id !== movementId);
    try {
      computePosition(position.kind, rest.map(calcOf));
    } catch {
      throw new BadRequestError('Deleting this movement would leave a later sale without the holding it needs');
    }
    await tx.investmentMovement.delete({ where: { id: movementId } });
    return { position: positionView(position, rest) };
  });
}
