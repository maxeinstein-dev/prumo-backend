import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors/index.js';
import { buildPaginationArgs, createPaginatedResponse } from '../../shared/utils/pagination.js';
import {
  createMovementInTx,
  createStockPositionInTx,
  findMovementBySourceRef,
  loadPosition,
  loadWritableAccount,
} from '../investments/investments.service.js';
import type { ConfirmInvestmentCaptureInput } from './captures.schema.js';
import {
  XP_PACKAGE,
  investmentSourceRef,
  isInvestmentDraftKind,
  saoPauloDay,
  studyCutoff,
  studyExpiry,
  suggestedQuantity,
} from './capture-xp.js';

/**
 * XP in the captures (P21 L6): the draft hints, the "em estudo" list and its 60-day cleanup, and the confirmation of a
 * draft as an INVESTMENT MOVEMENT. Nothing here creates a lançamento or moves the balance of an account: the aporte is
 * already in the balance as a transfer and a purchase only consumes it in the calculation of the investments module
 * (captures.xp.no-transaction.test.ts pins this in the source).
 */

const dayDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

interface ParsedFields {
  kind?: unknown;
  ticker?: unknown;
  amountCents?: unknown;
  executionDate?: unknown;
}
const fieldsOf = (parsed: unknown): ParsedFields => (parsed && typeof parsed === 'object' ? (parsed as ParsedFields) : {});

// ------------------------------------------------------------------------------------------------ draft suggestion

export interface InvestmentHint {
  movementType: 'INCOME' | 'BUY';
  ticker: string;
  /** Reais, from the integer cents of the reading. */
  amount: number;
  /** The day of the notification on the clock of Brasilia (YYYY-MM-DD): the date the movement takes unless corrected. */
  date: string;
  /** Purchase only: amount / last quote up to `date`, nearest integer, at least 1. null without a quote. */
  quantity: number | null;
  quote: { price: number; date: string } | null;
  /** The open positions of the ticker in the household: the screen picks one, or offers to create it. */
  positions: Array<{ id: string; accountId: string; name: string }>;
  /** The reinvestment notice announced for this day and ticker, kept only to pair with the execution. */
  pairedNotice: { captureId: string; amount: number; announcedDate: string } | null;
}

interface HintRow {
  id: string;
  postedAt: Date;
  parsed: unknown;
}

/** The hints of the XP drafts of one page of captures (a handful of queries, none for a page without XP drafts). */
export async function loadInvestmentHints(householdId: string, rows: readonly HintRow[]): Promise<Map<string, InvestmentHint>> {
  const out = new Map<string, InvestmentHint>();
  const drafts = rows.flatMap((row) => {
    const f = fieldsOf(row.parsed);
    const movementType = isInvestmentDraftKind(f.kind);
    const cents = f.amountCents;
    if (!movementType || typeof f.ticker !== 'string' || typeof cents !== 'number' || !Number.isSafeInteger(cents) || cents <= 0) return [];
    return [{ row, movementType, ticker: f.ticker, cents }];
  });
  if (drafts.length === 0) return out;

  const tickers = [...new Set(drafts.map((d) => d.ticker))];
  const positions = (await prisma.investmentPosition.findMany({
    where: { householdId, kind: 'STOCK_EXCHANGE', closedAt: null, ticker: { in: tickers } },
    select: { id: true, accountId: true, ticker: true, name: true },
    orderBy: [{ createdAt: 'asc' }],
  })) as Array<{ id: string; accountId: string; ticker: string; name: string }>;

  const notices = drafts.some((d) => d.movementType === 'BUY')
    ? ((await prisma.capturedNotification.findMany({
        where: { householdId, status: 'IGNORED', package: XP_PACKAGE },
        select: { id: true, postedAt: true, parsed: true },
        orderBy: [{ postedAt: 'desc' }],
        take: 200,
      })) as HintRow[])
    : [];

  for (const { row, movementType, ticker, cents } of drafts) {
    const date = saoPauloDay(row.postedAt);
    let quote: InvestmentHint['quote'] = null;
    let pairedNotice: InvestmentHint['pairedNotice'] = null;
    if (movementType === 'BUY') {
      // The last close up to the day (a newer one is never read), like the value of a position.
      const found = (await prisma.assetQuote.findFirst({
        where: { ticker, date: { lte: dayDate(date) } },
        orderBy: { date: 'desc' },
      })) as { date: Date; close: { toNumber(): number } } | null;
      if (found) quote = { price: found.close.toNumber(), date: found.date.toISOString().slice(0, 10) };
      const notice = notices.find((n) => {
        const f = fieldsOf(n.parsed);
        return f.kind === 'XP_REINVEST_NOTICE' && f.ticker === ticker && f.executionDate === date && typeof f.amountCents === 'number';
      });
      if (notice) pairedNotice = { captureId: notice.id, amount: (fieldsOf(notice.parsed).amountCents as number) / 100, announcedDate: date };
    }
    out.set(row.id, {
      movementType,
      ticker,
      amount: cents / 100,
      date,
      quantity: movementType === 'BUY' ? suggestedQuantity(cents, quote?.price ?? null) : null,
      quote,
      positions: positions.filter((p) => p.ticker === ticker).map((p) => ({ id: p.id, accountId: p.accountId, name: p.name })),
      pairedNotice,
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------ em estudo

export async function listStudyCaptures(householdId: string, query: { package?: string; cursor?: string; limit: number }) {
  const rows = await prisma.capturedNotification.findMany({
    where: { householdId, status: 'STUDY', ...(query.package ? { package: query.package } : {}) },
    select: { id: true, package: true, title: true, text: true, postedAt: true, createdAt: true },
    orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
    ...buildPaginationArgs({ cursor: query.cursor, limit: query.limit }),
  });
  const page = createPaginatedResponse(rows, query.limit);
  return {
    data: page.data.map((row) => ({ ...row, expiresAt: studyExpiry(row.createdAt).toISOString() })),
    pagination: page.pagination,
  };
}

/**
 * Decision 3 of P21: what stays "em estudo" for more than 60 days is deleted (only that status: a draft, a confirmed or
 * dismissed capture and the reinvestment notices are never touched). Run by the daily investments command.
 */
export async function purgeStudyCaptures(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.capturedNotification.deleteMany({ where: { status: 'STUDY', createdAt: { lt: studyCutoff(now) } } });
  return count;
}

// ------------------------------------------------------------------------------------------------------- confirm

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown })?.code === 'P2002';

type Found = NonNullable<Awaited<ReturnType<typeof findMovementBySourceRef>>>;

export interface ConfirmInvestmentResult {
  /** false when the capture was already confirmed (nothing was created by this call). */
  created: boolean;
  capture: { id: string; status: 'CONFIRMED'; movementId: string };
  movement: Found['movement'];
  position: Found['position'];
  positionCreated: boolean;
}

async function alreadyConfirmed(householdId: string, captureId: string, sourceRef: string): Promise<ConfirmInvestmentResult | null> {
  const found = await findMovementBySourceRef(householdId, sourceRef);
  if (!found) return null;
  return { created: false, capture: { id: captureId, status: 'CONFIRMED', movementId: found.movement.id }, ...found, positionCreated: false };
}

/**
 * Turns a PENDING XP draft (income or executed reinvestment) into an investment movement, once. The capture is claimed
 * (PENDING -> CONFIRMED) in the SAME database transaction that writes the movement (and the position, when the ticker had
 * none), so there is never a confirmed capture without its movement. `sourceRef = notif:<dedupKey>` is unique per
 * household: of two simultaneous confirmations one commits, the other loses the claim and answers the winner's movement.
 * The quantity of a purchase comes from the user (the draft only suggests it); an income takes none.
 */
export async function confirmInvestmentCapture(
  scope: { householdId: string; userId: string },
  captureId: string,
  input: ConfirmInvestmentCaptureInput,
): Promise<ConfirmInvestmentResult> {
  const { householdId } = scope;
  const capture = await prisma.capturedNotification.findFirst({
    where: { id: captureId, householdId },
    select: { id: true, status: true, parsed: true, dedupKey: true },
  });
  if (!capture) throw new NotFoundError('Capture');
  const f = fieldsOf(capture.parsed);
  const type = isInvestmentDraftKind(f.kind);
  if (!type || typeof f.ticker !== 'string') throw new BadRequestError('This capture is not an investment draft');
  const ticker = f.ticker;
  const sourceRef = investmentSourceRef(capture.dedupKey);

  if (capture.status === 'CONFIRMED') {
    const done = await alreadyConfirmed(householdId, capture.id, sourceRef);
    if (!done) throw new ConflictError('The movement created from this capture was deleted; the capture stays confirmed and cannot be confirmed again');
    return done;
  }
  if (capture.status !== 'PENDING') throw new ConflictError(`A ${capture.status.toLowerCase()} capture cannot be confirmed`);

  if ((input.positionId === undefined) === (input.newPosition === undefined)) {
    throw new BadRequestError('Inform exactly one of positionId and newPosition');
  }
  if (type === 'INCOME' && input.quantity !== undefined) throw new BadRequestError('An income carries only the amount');
  if (type === 'BUY' && input.quantity === undefined) throw new BadRequestError('Inform the quantity of the purchase');

  let existing: Awaited<ReturnType<typeof loadPosition>> | null = null;
  let account: Awaited<ReturnType<typeof loadWritableAccount>> | null = null;
  if (input.positionId !== undefined) {
    existing = await loadPosition(input.positionId);
    if (existing.householdId !== householdId) throw new NotFoundError('Position');
    if (existing.kind !== 'STOCK_EXCHANGE' || existing.ticker !== ticker) throw new BadRequestError(`This draft is for ${ticker}: choose a position with that ticker`);
    if (existing.closedAt) throw new BadRequestError('The position is closed');
  } else {
    account = await loadWritableAccount(input.newPosition!.accountId, householdId);
  }

  const movementInput = {
    type,
    date: input.date,
    amount: input.amount,
    ...(type === 'BUY' ? { quantity: input.quantity } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    sourceRef,
  };

  try {
    const result = await prisma.$transaction(async (tx) => {
      const claimed = await tx.capturedNotification.updateMany({
        where: { id: capture.id, householdId, status: 'PENDING' },
        data: { status: 'CONFIRMED' },
      });
      if (claimed.count !== 1) throw new ConflictError('The capture is no longer pending');
      const position =
        existing ??
        (await createStockPositionInTx(tx, account!, {
          ticker,
          name: input.newPosition!.name ?? ticker,
          savingsGoalId: input.newPosition!.savingsGoalId,
        }));
      return createMovementInTx(tx, position, movementInput);
    });
    return { created: true, capture: { id: capture.id, status: 'CONFIRMED', movementId: result.movement.id }, ...result, positionCreated: existing === null };
  } catch (error) {
    if ((error as { statusCode?: unknown })?.statusCode !== 409 && !isUniqueViolation(error)) throw error;
    // The loser of a race (or a retry): converge on the movement that owns the reference, when there is one.
    const done = await alreadyConfirmed(householdId, capture.id, sourceRef);
    if (done) return done;
    throw error;
  }
}
