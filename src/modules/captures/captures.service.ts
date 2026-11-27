import { createHash } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors/index.js';
import { buildPaginationArgs, createPaginatedResponse } from '../../shared/utils/pagination.js';
import { createInstallmentRowsInTx, createTransaction, createTransfer, getTransactionWithHousehold, resolveAccountForTransaction } from '../transactions/transactions.service.js';
import type { CreateTransactionInput } from '../transactions/transactions.schema.js';
import { checkNewTransactionSplit, writeNewTransactionSharesInTx } from '../people/shares.service.js';
import { buildCategoryHints, type CategoryHints } from './capture-category.js';
import { buildSuggestion, suggestedPlace, type SuggestionCardRule, type SuggestionRule } from './capture-suggestion.js';
import { PARSED_PACKAGES, PARSER_VERSION, parseCapture, type ParsedCapture } from './parsers/index.js';
import { isAllowedGmailSender } from './parsers/gmail.js';
import { DUPLICATE_WINDOW_MS, GMAIL_PACKAGE, duplicatesToDismiss, isAppOutflow, isEmailOutflow } from './capture-duplicates.js';
import type { AccountRuleInput, CaptureItemInput, CaptureStatusValue, CardRuleInput, ConfirmCaptureInput, ConfirmTransferInput } from './captures.schema.js';
import { readingOf } from './capture-pairing.js';
import { captureInstallmentPlanId, captureInstallmentRef, installmentAmountsCents, installmentDates } from './capture-installments.js';
import { isXpKind } from './capture-xp.js';
import { loadInvestmentHints, type InvestmentHint } from './captures.xp.js';
import { TRANSFER_WINDOW_MS, isTransferIn, isTransferOut, ownTransferPairs } from './capture-transfer.js';

/**
 * A notice is dismissed (decided 13/11/2026; "restore" brings it back); anything else waits for the user. XP (P21 L6): a
 * text no reader understands is STUDY (outside the box, deleted after 60 days) and the reinvestment notice is IGNORED
 * (kept only to pair with the execution, no draft).
 */
function statusOfReading(parsed: ParsedCapture | null): 'PENDING' | 'DISMISSED' | 'IGNORED' | 'STUDY' {
  if (parsed?.kind === 'XP_STUDY') return 'STUDY';
  if (parsed?.kind === 'XP_REINVEST_NOTICE') return 'IGNORED';
  return parsed?.ignore ? 'DISMISSED' : 'PENDING';
}

/**
 * A new spending the server understood, answered to the phone so it can show a local notice ("Compra de R$ X
 * capturada: confirmar?", P01 D3). The phone only formats it: what counts as a spending and its value come from here.
 */
export interface CaptureNotice {
  kind: ParsedCapture['kind'];
  amountCents: number;
  merchant?: string;
}

export interface CaptureResult {
  dedupKey: string;
  /** `ignored`: an e-mail from a sender that is not a bank; nothing of it was stored. */
  status: 'created' | 'duplicate' | 'ignored';
  /** Only on a `created` item whose reading is a spending with a value; absent otherwise. */
  notice?: CaptureNotice;
}

/** A stored capture as the duplicate pass sees it (from the request, or from a reparse). */
interface FreshCapture {
  dedupKey: string;
  postedAt: Date;
  package: string;
  parsed: unknown;
}

/**
 * After captures are stored or re-read: of an e-mail and a Mercado Pago app notification of the same Pix (see
 * capture-duplicates.ts), the e-mail is dismissed, or the app notification when the e-mail was already confirmed; the
 * dismissed one carries `duplicateOf` in its reading so the screen can say why. Only pairs that involve one of `fresh`
 * are acted on, so a capture the user restored is not dismissed again by an unrelated upload.
 *
 * Returns the dedup keys of `fresh` that must not raise a phone notice: the ones dismissed, and the ones whose twin
 * arrived earlier (that twin already raised the notice for this Pix).
 */
async function dismissDuplicates(householdId: string, fresh: readonly FreshCapture[]): Promise<Set<string>> {
  const silenced = new Set<string>();
  const relevant = fresh.filter((e) => isEmailOutflow(e) || isAppOutflow(e));
  if (relevant.length === 0) return silenced;
  const times = relevant.map((e) => e.postedAt.getTime());
  const window = await prisma.capturedNotification.findMany({
    where: {
      householdId,
      postedAt: { gte: new Date(Math.min(...times) - DUPLICATE_WINDOW_MS), lte: new Date(Math.max(...times) + DUPLICATE_WINDOW_MS) },
    },
    select: { id: true, package: true, status: true, postedAt: true, parsed: true, dedupKey: true },
  });
  const freshKeys = new Set(relevant.map((e) => e.dedupKey));
  const byId = new Map(window.map((c) => [c.id, c]));
  for (const pair of duplicatesToDismiss(window)) {
    const dropped = byId.get(pair.id)!;
    const kept = byId.get(pair.duplicateOf)!;
    if (!freshKeys.has(dropped.dedupKey) && !freshKeys.has(kept.dedupKey)) continue;
    const reading = (dropped.parsed ?? {}) as Prisma.InputJsonObject;
    const { count } = await prisma.capturedNotification.updateMany({
      where: { id: dropped.id, householdId, status: 'PENDING' },
      data: { status: 'DISMISSED', parsed: { ...reading, duplicateOf: kept.id } },
    });
    if (count === 0) continue;
    if (freshKeys.has(dropped.dedupKey)) silenced.add(dropped.dedupKey);
    // The kept one arrived in this request only if it is fresh; otherwise it already raised the notice of this Pix.
    if (freshKeys.has(kept.dedupKey) && !freshKeys.has(dropped.dedupKey)) silenced.add(kept.dedupKey);
  }
  return silenced;
}

/** A spending worth a notice: an EXPENSE reading with a positive value; never a notice (IGNORE) or an income. */
export function noticeOfReading(parsed: ParsedCapture | null): CaptureNotice | undefined {
  if (!parsed || parsed.ignore || parsed.type !== 'EXPENSE') return undefined;
  if (parsed.amountCents === null || !(parsed.amountCents > 0)) return undefined;
  return { kind: parsed.kind, amountCents: parsed.amountCents, ...(parsed.merchant ? { merchant: parsed.merchant } : {}) };
}

const MINUTE_MS = 60_000;

/** `postedAt` cut to the minute, as a UTC ISO string: the same notification sent twice, or in two zones, hashes alike. */
export function postedAtToMinuteIso(postedAt: Date): string {
  return new Date(Math.floor(postedAt.getTime() / MINUTE_MS) * MINUTE_MS).toISOString();
}

/** sha1(package | postedAt to the minute (UTC ISO) | title ?? '' | text), hex (40 chars). */
export function computeDedupKey(item: { package: string; title?: string | null; postedAt: Date; text: string }): string {
  return createHash('sha1')
    .update([item.package, postedAtToMinuteIso(item.postedAt), item.title ?? '', item.text].join('|'))
    .digest('hex');
}

/**
 * Stores the raw captures of one device request, idempotently, and reports each item in input order.
 * One INSERT ... ON CONFLICT DO NOTHING RETURNING: the unique (household_id, dedup_key) decides, so two concurrent
 * requests with the same item create one row, and only the winner sees it as `created`.
 */
export async function ingestCaptures(
  scope: { householdId: string; userId: string },
  items: CaptureItemInput[]
): Promise<CaptureResult[]> {
  const prepared = items.map((item) => {
    const postedAt = new Date(item.postedAt);
    // An e-mail is stored only when a reader understood it: one from another sender (the phone already drops it) or one
    // of a listed sender that is not a transaction (a promotion, an invoice, a statement) is never kept, so its text,
    // which may carry a balance or a document number, does not reach the database.
    const isEmail = item.package === GMAIL_PACKAGE;
    const parsed = isEmail && !isAllowedGmailSender(item.title ?? null)
      ? null
      : parseCapture({ package: item.package, title: item.title ?? null, text: item.text });
    const ignored = isEmail && parsed === null;
    return { item, postedAt, parsed, ignored, dedupKey: computeDedupKey({ ...item, postedAt }) };
  });

  // Repeats inside the batch: only the first occurrence is inserted (a repeat in one INSERT would be skipped
  // anyway, but then the result could not say which of the two was the creator).
  const firstByKey = new Map<string, (typeof prepared)[number]>();
  for (const entry of prepared) {
    if (!entry.ignored && !firstByKey.has(entry.dedupKey)) firstByKey.set(entry.dedupKey, entry);
  }

  const inserted = await prisma.capturedNotification.createManyAndReturn({
    data: [...firstByKey.values()].map(({ item, postedAt, parsed, dedupKey }) => {
      // The raw text is stored either way; a reading adds `parsed`, and a notice (limit, promotion) is stored DISMISSED
      // so the user can still restore it. The version is stored even when nothing was understood: reparse retries
      // only what an older parser read.
      return {
        householdId: scope.householdId,
        userId: scope.userId,
        package: item.package,
        title: item.title ?? null,
        text: item.text,
        postedAt,
        dedupKey,
        status: statusOfReading(parsed),
        parserVersion: PARSER_VERSION,
        ...(parsed ? { parsed: parsed as unknown as Prisma.InputJsonObject } : {}),
      };
    }),
    skipDuplicates: true,
    select: { dedupKey: true },
  });
  const created = new Set(inserted.map((row) => row.dedupKey));
  const dismissed = await dismissDuplicates(
    scope.householdId,
    [...firstByKey.values()].filter((e) => created.has(e.dedupKey)).map((e) => ({ dedupKey: e.dedupKey, postedAt: e.postedAt, package: e.item.package, parsed: e.parsed })),
  );

  const reported = new Set<string>();
  return prepared.map(({ dedupKey, parsed, ignored }) => {
    if (ignored) return { dedupKey, status: 'ignored' as const };
    const isCreator = created.has(dedupKey) && !reported.has(dedupKey);
    reported.add(dedupKey);
    if (!isCreator) return { dedupKey, status: 'duplicate' as const };
    // One notice per Pix: a capture dismissed as a duplicate, or whose twin arrived earlier, raises none.
    const notice = dismissed.has(dedupKey) ? undefined : noticeOfReading(parsed);
    return { dedupKey, status: 'created' as const, ...(notice ? { notice } : {}) };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Drafts (user JWT): list, count, confirm, dismiss, restore and the account rules.
// ---------------------------------------------------------------------------------------------------------------

const CAPTURE_SELECT = {
  id: true,
  package: true,
  title: true,
  text: true,
  postedAt: true,
  status: true,
  parsed: true,
  transactionId: true,
} as const;

type CaptureRow = Prisma.CapturedNotificationGetPayload<{ select: typeof CAPTURE_SELECT }>;

/** The other side of a possible own transfer (see capture-transfer.ts), with the account its draft would take. */
export interface TransferPairDto {
  captureId: string;
  /** Which side THIS capture is: the outflow or the income. */
  side: 'out' | 'in';
  partnerAccountId: string | null;
}

function toCaptureDto(
  row: CaptureRow,
  rules: readonly SuggestionRule[],
  cardRules: readonly SuggestionCardRule[] = [],
  hints?: CategoryHints,
  transferPair: TransferPairDto | null = null,
  investment?: InvestmentHint,
) {
  // Explicit fields: the rows of the transition routes also carry the dedupKey, which is not part of the API.
  const { id, package: pkg, title, text, postedAt, status, parsed, transactionId } = row;
  return { id, package: pkg, title, text, postedAt, status, parsed, transactionId, suggestion: { ...buildSuggestion(row, rules, cardRules, hints), ...(investment ? { investment } : {}) }, transferPair };
}

/**
 * The possible own transfers that involve a capture of the page: the pending outflows and own incomes posted around the
 * page are read (one query, the household only) and paired. A partner may be on another page; its suggested account
 * comes with the pair so the screen can offer the transfer with both accounts filled.
 */
async function loadTransferPairs(
  householdId: string,
  rows: readonly CaptureRow[],
  rules: readonly SuggestionRule[],
  cardRules: readonly SuggestionCardRule[],
): Promise<Map<string, TransferPairDto>> {
  const out = new Map<string, TransferPairDto>();
  const relevant = rows.filter((r) => isTransferOut(r) || isTransferIn(r));
  if (relevant.length === 0) return out;
  const times = relevant.map((r) => r.postedAt.getTime());
  const window = await prisma.capturedNotification.findMany({
    where: {
      householdId,
      status: 'PENDING',
      postedAt: { gte: new Date(Math.min(...times) - TRANSFER_WINDOW_MS), lte: new Date(Math.max(...times) + TRANSFER_WINDOW_MS) },
    },
    select: CAPTURE_SELECT,
  });
  const byId = new Map(window.map((c) => [c.id, c]));
  const accountOf = (id: string) => buildSuggestion(byId.get(id)!, rules, cardRules).accountId;
  for (const pair of ownTransferPairs(window)) {
    out.set(pair.outId, { captureId: pair.inId, side: 'out', partnerAccountId: accountOf(pair.inId) });
    out.set(pair.inId, { captureId: pair.outId, side: 'in', partnerAccountId: accountOf(pair.outId) });
  }
  return out;
}

/** How far back the category hint looks: a year of the household's own transactions is enough to know a place. */
const HINT_HISTORY_DAYS = 365;
const HINT_HISTORY_MAX_ROWS = 5000;

/**
 * The category hints of one page of captures, in three queries, or none when no capture of the page names a place.
 * Every query is scoped to the household.
 */
async function loadCategoryHints(householdId: string, rows: readonly CaptureRow[]): Promise<CategoryHints | undefined> {
  if (!rows.some((row) => suggestedPlace(row.parsed))) return undefined;
  const since = new Date(Date.now() - HINT_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const [history, recurrences, customCategories] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        householdId,
        type: { in: ['INCOME', 'EXPENSE'] },
        categoryName: { not: null },
        description: { not: null },
        date: { gte: since },
      },
      select: { type: true, description: true, categoryName: true, date: true, createdAt: true },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: HINT_HISTORY_MAX_ROWS,
    }),
    prisma.recurringTransaction.findMany({
      where: { householdId, isActive: true },
      select: { description: true, aliases: true, categoryName: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    }),
    prisma.category.findMany({ where: { householdId }, select: { id: true, type: true } }),
  ]);
  return buildCategoryHints({ history, recurrences, customCategories });
}

/** Newest first; `id` breaks ties between captures of the same instant so cursor pages neither overlap nor skip. */
const CAPTURE_ORDER: Prisma.CapturedNotificationOrderByWithRelationInput[] = [{ postedAt: 'desc' }, { id: 'desc' }];

export async function listCaptures(householdId: string, query: { status: CaptureStatusValue; cursor?: string; limit: number }) {
  const [rows, rules, cardRules] = await Promise.all([
    prisma.capturedNotification.findMany({
      where: { householdId, status: query.status },
      select: CAPTURE_SELECT,
      orderBy: CAPTURE_ORDER,
      ...buildPaginationArgs({ cursor: query.cursor, limit: query.limit }),
    }),
    prisma.captureAccountRule.findMany({ where: { householdId }, select: { package: true, kind: true, accountId: true } }),
    prisma.captureCardRule.findMany({ where: { householdId }, select: { package: true, cardLast4: true, accountId: true } }),
  ]);
  const page = createPaginatedResponse(rows, query.limit);
  const [hints, pairs, investments] = await Promise.all([
    loadCategoryHints(householdId, page.data),
    loadTransferPairs(householdId, page.data, rules, cardRules),
    loadInvestmentHints(householdId, page.data),
  ]);
  return {
    data: page.data.map((row) => toCaptureDto(row, rules, cardRules, hints, pairs.get(row.id) ?? null, investments.get(row.id))),
    pagination: page.pagination,
  };
}

export async function countCaptures(householdId: string, status: CaptureStatusValue): Promise<number> {
  return prisma.capturedNotification.count({ where: { householdId, status } });
}

async function loadCapture(householdId: string, id: string) {
  const capture = await prisma.capturedNotification.findFirst({
    where: { id, householdId },
    select: { ...CAPTURE_SELECT, dedupKey: true },
  });
  if (!capture) throw new NotFoundError('Capture');
  return capture;
}

/** The source reference of the transaction a capture becomes: unique per household, so it is the dedup of confirm. */
export function captureSourceRef(dedupKey: string): string {
  return `notif:${dedupKey}`;
}

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown })?.code === 'P2002';

/**
 * 409: the capture is CONFIRMED but its transaction was deleted afterwards (the FK sets transaction_id to NULL).
 * Deleting a transaction leaves the capture as is; it is out of the PENDING list and cannot be confirmed again.
 */
export class CaptureTransactionRemovedError extends ConflictError {
  constructor() {
    super('The transaction created from this capture was deleted; the capture stays confirmed and cannot be confirmed again');
  }
}

export interface ConfirmResult {
  /** false when the capture was already confirmed (nothing was created by this call). */
  created: boolean;
  capture: { id: string; status: CaptureStatusValue; transactionId: string };
  /** The first installment when the capture was confirmed in installments. */
  transaction: Awaited<ReturnType<typeof getTransactionWithHousehold>>;
  /** Ids of installments 2..n, only when this call created a purchase in installments. */
  installmentIds?: string[];
}

async function confirmedResult(householdId: string, captureId: string, transactionId: string, created: boolean): Promise<ConfirmResult> {
  return {
    created,
    capture: { id: captureId, status: 'CONFIRMED', transactionId },
    transaction: await getTransactionWithHousehold(transactionId, householdId),
  };
}

/**
 * Turns a PENDING capture into a transaction, once.
 *
 * Mechanism: the transaction is created through createTransaction with `sourceRef = notif:<dedupKey>` and the capture
 * is claimed (PENDING -> CONFIRMED, transaction_id set) by the `inTransaction` hook, i.e. in the SAME database
 * transaction as the insert and the balance update. So there is never a CONFIRMED capture without a transaction, nor
 * a notification transaction whose capture is still PENDING; if the claim finds the capture no longer PENDING (a
 * concurrent dismiss) it throws and the whole creation rolls back (409).
 * Race: of two simultaneous confirms the unique (household_id, source_ref) lets one insert commit; the other blocks on
 * the index, then fails with P2002 and answers with the winner's transaction. A leftover transaction carrying the
 * reference while the capture is PENDING (not producible by this code, but cheap to heal) is linked by the same path.
 */
export async function confirmCapture(
  scope: { householdId: string; userId: string },
  captureId: string,
  input: ConfirmCaptureInput
): Promise<ConfirmResult> {
  const { householdId, userId } = scope;
  const capture = await loadCapture(householdId, captureId);

  if (capture.status === 'CONFIRMED') {
    if (!capture.transactionId) throw new CaptureTransactionRemovedError();
    return confirmedResult(householdId, capture.id, capture.transactionId, false);
  }
  if (capture.status !== 'PENDING') {
    throw new ConflictError(`A ${capture.status.toLowerCase()} capture cannot be confirmed`);
  }

  // P21 L6: an XP draft is an investment movement, never a lançamento (it would count the money twice).
  if (isXpKind((capture.parsed as { kind?: unknown } | null)?.kind)) {
    throw new BadRequestError('An XP capture is confirmed as an investment movement (POST /captures/:id/confirm-investment), not as a transaction');
  }

  // P19: the split ("Metade com", "É de") is checked before anything is written, and written with the transaction
  const { shares: split, installments, installmentAmount, ...fields } = input;
  if (installments !== undefined) return confirmInInstallments(scope, capture, fields, installments, installmentAmount, split);
  // A capture the reader took for a refund ("A compra em X foi estornada") is an income that cancels an expense:
  // it is written as one (explicit INCOME, so the expense category of the purchase does not turn it into an expense)
  // and marked, unless the user turned it into an expense on purpose. The marker is never taken from the client.
  const asRefund = (capture.parsed as { kind?: unknown } | null)?.kind === 'REFUND' && fields.type !== 'EXPENSE';
  const splitFacts = { type: asRefund ? 'INCOME' : (fields.type ?? ''), amountCents: Math.round(fields.amount * 100) };
  if (split) await checkNewTransactionSplit(prisma, householdId, splitFacts, split);

  const sourceRef = captureSourceRef(capture.dedupKey);
  try {
    const transaction = await createTransaction(
      { ...fields, ...(asRefund ? { type: 'INCOME', isRefund: true } : {}), householdId, sourceRef, isSplit: false } as CreateTransactionInput,
      userId,
      {
        inTransaction: async (tx, created) => {
          const claimed = await tx.capturedNotification.updateMany({
            where: { id: capture.id, householdId, status: 'PENDING' },
            data: { status: 'CONFIRMED', transactionId: created.id },
          });
          if (claimed.count !== 1) throw new ConflictError('The capture is no longer pending');
          if (split) await writeNewTransactionSharesInTx(tx, householdId, created.id, splitFacts, split);
        },
      }
    );
    return { created: true, capture: { id: capture.id, status: 'CONFIRMED', transactionId: transaction.id }, transaction };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return resolveSourceRefConflict(householdId, capture.id, sourceRef, error);
  }
}

/**
 * P22: a capture confirmed as a purchase in `installments` (2..24) on a credit card. `fields.amount` is the TOTAL of the
 * purchase. Installment 1 is created by createTransaction on the purchase date with the capture's own sourceRef; the
 * others are written by createInstallmentRowsInTx from the same `inTransaction` hook that claims the capture
 * (PENDING -> CONFIRMED), so either every installment exists and the capture is confirmed, or nothing is written.
 * The race of two simultaneous confirms ends exactly as in the single-transaction case: the loser fails on the unique
 * sourceRef of installment 1 and answers with the winner's.
 */
async function confirmInInstallments(
  scope: { householdId: string; userId: string },
  capture: Awaited<ReturnType<typeof loadCapture>>,
  fields: Omit<ConfirmCaptureInput, 'shares' | 'installments' | 'installmentAmount'>,
  installments: number,
  installmentAmount: number | undefined,
  split: ConfirmCaptureInput['shares'],
): Promise<ConfirmResult> {
  const { householdId, userId } = scope;
  if ((capture.parsed as { kind?: unknown } | null)?.kind === 'REFUND' && fields.type !== 'EXPENSE') {
    throw new BadRequestError('Installments are only for an expense: this capture is a refund');
  }
  if (fields.type === 'INCOME') throw new BadRequestError('Installments are only for an expense');
  if (fields.competenceMonth) {
    throw new BadRequestError('A purchase in installments has no single reference month: its installments are dated one per month');
  }
  // The same resolution createTransaction does: an account of the household, or a personal account of a member who
  // allowed access (404/403 as in the normal path); then it must still be a credit card.
  const resolved = await resolveAccountForTransaction(householdId, fields.accountId, userId);
  if (!resolved || resolved.type !== 'CREDIT') {
    throw new BadRequestError('Installments are only for a credit card account');
  }
  const account = { id: resolved.id, type: resolved.type };

  const amounts = installmentAmountsCents(
    Math.round(fields.amount * 100),
    installments,
    installmentAmount === undefined ? undefined : Math.round(installmentAmount * 100),
  );
  if (amounts.some((cents) => cents < 1)) throw new BadRequestError('The amount is too small to be divided in that many installments');
  if (split) {
    // Every installment gets the split of ITS value: the first one may be a few cents larger than the others.
    for (const cents of new Set(amounts)) await checkNewTransactionSplit(prisma, householdId, { type: 'EXPENSE', amountCents: cents }, split);
  }

  const dates = installmentDates(fields.date, installments);
  const planId = captureInstallmentPlanId(capture.dedupKey);
  const sourceRef = captureInstallmentRef(capture.dedupKey, 1);
  const extraIds: string[] = [];
  try {
    const transaction = await createTransaction(
      {
        ...fields,
        // Like the form: an installment of a card is paid (it takes the limit), and the installments have no reference month.
        paid: true,
        competenceMonth: null,
        type: 'EXPENSE',
        amount: amounts[0]! / 100,
        date: dates[0]!,
        householdId,
        sourceRef,
        isSplit: false,
        installmentId: planId,
        installmentNumber: 1,
        totalInstallments: installments,
      } as CreateTransactionInput,
      userId,
      {
        // 24 installments (and a split) are ~100 round trips: far over Prisma's default 5 s on a remote database.
        transactionOptions: { maxWait: 10_000, timeout: 60_000 },
        inTransaction: async (tx, created) => {
          const claimed = await tx.capturedNotification.updateMany({
            where: { id: capture.id, householdId, status: 'PENDING' },
            data: { status: 'CONFIRMED', transactionId: created.id },
          });
          if (claimed.count !== 1) throw new ConflictError('The capture is no longer pending');
          if ((created as { type?: string }).type && (created as { type?: string }).type !== 'EXPENSE') {
            throw new BadRequestError('Installments are only for an expense');
          }
          const ids = await createInstallmentRowsInTx(tx, {
            householdId,
            account,
            categoryName: fields.categoryName,
            description: fields.description,
            notes: fields.notes,
            installmentId: planId,
            totalInstallments: installments,
            rows: amounts.slice(1).map((amountCents, i) => ({
              installmentNumber: i + 2,
              amountCents,
              date: dates[i + 1]!,
              sourceRef: captureInstallmentRef(capture.dedupKey, i + 2),
            })),
          });
          extraIds.push(...ids);
          if (split) {
            const rows = [created.id, ...ids];
            for (let i = 0; i < rows.length; i++) {
              await writeNewTransactionSharesInTx(tx, householdId, rows[i]!, { type: 'EXPENSE', amountCents: amounts[i]! }, split);
            }
          }
        },
      },
    );
    return { created: true, capture: { id: capture.id, status: 'CONFIRMED', transactionId: transaction.id }, transaction, installmentIds: extraIds };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return resolveSourceRefConflict(householdId, capture.id, sourceRef, error);
  }
}

/** The loser of a confirm race (or a retry after a crash): converge on the transaction that owns the reference. */
async function resolveSourceRefConflict(householdId: string, captureId: string, sourceRef: string, original: unknown): Promise<ConfirmResult> {
  const owner = await prisma.transaction.findFirst({ where: { householdId, sourceRef }, select: { id: true } });
  if (!owner) throw original; // the unique violation was about something else
  const current = await prisma.capturedNotification.findFirst({ where: { id: captureId, householdId }, select: { status: true, transactionId: true } });
  if (!current) throw new NotFoundError('Capture');

  if (current.status === 'PENDING') {
    // Link the capture to the transaction that already carries its reference (conditional, so two heals agree).
    await prisma.capturedNotification.updateMany({
      where: { id: captureId, householdId, status: 'PENDING' },
      data: { status: 'CONFIRMED', transactionId: owner.id },
    });
    const healed = await prisma.capturedNotification.findFirst({ where: { id: captureId, householdId }, select: { status: true, transactionId: true } });
    if (healed?.status === 'CONFIRMED' && healed.transactionId === owner.id) return confirmedResult(householdId, captureId, owner.id, false);
  } else if (current.status === 'CONFIRMED' && current.transactionId === owner.id) {
    return confirmedResult(householdId, captureId, owner.id, false);
  }
  throw new ConflictError('The capture was changed by another request');
}

/** PENDING -> DISMISSED. Idempotent on DISMISSED; CONFIRMED and IGNORED answer 409. */
export interface TransferPairResult {
  /** false when both captures were already confirmed with this transfer (nothing was created by this call). */
  created: boolean;
  captures: { id: string; status: CaptureStatusValue; transactionId: string }[];
  transaction: Awaited<ReturnType<typeof getTransactionWithHousehold>>;
}

/**
 * Confirms an outflow capture and an own-income capture of the same Pix as ONE transfer between the two accounts
 * (decided by the user on 15/11/2026): no income, no expense, the balance moves once. Both captures are claimed in the
 * same database transaction as the transfer and its balances, so a side that is no longer pending writes nothing.
 * Idempotent: when both already point to the same transaction it answers that one. The transfer carries the outflow's
 * reference, so two simultaneous confirmations create one transfer.
 */
export async function confirmTransferPair(householdId: string, input: ConfirmTransferInput): Promise<TransferPairResult> {
  const [outCapture, inCapture] = await Promise.all([loadCapture(householdId, input.outCaptureId), loadCapture(householdId, input.inCaptureId)]);
  const together = (o: { status: string; transactionId: string | null }, i: { status: string; transactionId: string | null }) =>
    o.status === 'CONFIRMED' && i.status === 'CONFIRMED' && !!o.transactionId && o.transactionId === i.transactionId;
  if (together(outCapture, inCapture)) return transferResult(householdId, [outCapture.id, inCapture.id], outCapture.transactionId!, false);
  if (outCapture.status !== 'PENDING' || inCapture.status !== 'PENDING') {
    throw new ConflictError('Both captures must be pending to be confirmed as a transfer');
  }
  const outReading = readingOf(outCapture.parsed);
  const inReading = readingOf(inCapture.parsed);
  if (outCapture.id === inCapture.id || !isTransferOut(outCapture) || !isTransferIn(inCapture) || outReading!.cents !== inReading!.cents) {
    throw new BadRequestError('The captures are not an outflow and an own income of the same amount');
  }

  const sourceRef = captureSourceRef(outCapture.dedupKey);
  try {
    const transfer = await createTransfer(
      {
        householdId,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        amount: input.amount,
        date: input.date,
        ...(input.description ? { description: input.description } : {}),
        sourceRef,
      },
      {
        inTransaction: async (tx, created) => {
          const claimed = await tx.capturedNotification.updateMany({
            where: { id: { in: [outCapture.id, inCapture.id] }, householdId, status: 'PENDING' },
            data: { status: 'CONFIRMED', transactionId: created.id },
          });
          if (claimed.count !== 2) throw new ConflictError('One of the captures is no longer pending');
        },
      }
    );
    return transferResult(householdId, [outCapture.id, inCapture.id], transfer.id, true);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another confirmation won the race: answer its transfer when it took both captures.
    const [o, i] = await Promise.all([loadCapture(householdId, outCapture.id), loadCapture(householdId, inCapture.id)]);
    if (together(o, i)) return transferResult(householdId, [o.id, i.id], o.transactionId!, false);
    throw new ConflictError('The outflow was already confirmed some other way');
  }
}

async function transferResult(householdId: string, ids: string[], transactionId: string, created: boolean): Promise<TransferPairResult> {
  const transaction = await getTransactionWithHousehold(transactionId, householdId);
  return { created, captures: ids.map((id) => ({ id, status: 'CONFIRMED' as const, transactionId })), transaction };
}

export async function dismissCapture(householdId: string, id: string) {
  const { count } = await prisma.capturedNotification.updateMany({
    where: { id, householdId, status: 'PENDING' },
    data: { status: 'DISMISSED' },
  });
  const capture = await loadCapture(householdId, id);
  if (count !== 1 && capture.status !== 'DISMISSED') {
    throw new ConflictError(`A ${capture.status.toLowerCase()} capture cannot be dismissed`);
  }
  return toCaptureDto(capture, []);
}

/** DISMISSED -> PENDING (undo of an accidental dismiss). Any other status, PENDING included, answers 409. */
export async function restoreCapture(householdId: string, id: string) {
  const { count } = await prisma.capturedNotification.updateMany({
    where: { id, householdId, status: 'DISMISSED' },
    data: { status: 'PENDING' },
  });
  const capture = await loadCapture(householdId, id);
  if (count !== 1) {
    throw new ConflictError(`Only a dismissed capture can be restored (this one is ${capture.status.toLowerCase()})`);
  }
  return toCaptureDto(capture, []);
}

export async function listAccountRules(householdId: string) {
  return prisma.captureAccountRule.findMany({
    where: { householdId },
    select: { package: true, kind: true, accountId: true },
    orderBy: [{ package: 'asc' }, { kind: 'asc' }],
  });
}

/**
 * Replaces the household's rules with `rules`, in one database transaction. Every account must be an active account
 * of the household (404 otherwise, so another household's id is indistinguishable from a missing one). The household
 * row is locked FOR UPDATE so two simultaneous replaces apply one after the other instead of colliding on the unique.
 */
export async function replaceAccountRules(householdId: string, rules: AccountRuleInput[]) {
  const accountIds = [...new Set(rules.map((rule) => rule.accountId))];
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM households WHERE id = ${householdId}::uuid FOR UPDATE`;
    if (accountIds.length > 0) {
      const found = await tx.account.count({ where: { id: { in: accountIds }, householdId, isActive: true } });
      if (found !== accountIds.length) throw new NotFoundError('Account');
    }
    await tx.captureAccountRule.deleteMany({ where: { householdId } });
    if (rules.length > 0) {
      await tx.captureAccountRule.createMany({
        data: rules.map((rule) => ({ householdId, package: rule.package, kind: rule.kind, accountId: rule.accountId })),
      });
    }
  });
  return listAccountRules(householdId);
}

export async function listCardRules(householdId: string) {
  return prisma.captureCardRule.findMany({
    where: { householdId },
    select: { package: true, cardLast4: true, accountId: true },
    orderBy: [{ package: 'asc' }, { cardLast4: 'asc' }],
  });
}

/**
 * Replaces the household's card-ending rules, like replaceAccountRules (same lock, same 404 for an account outside
 * the household). The (package, kind) rules are not touched.
 */
export async function replaceCardRules(householdId: string, rules: CardRuleInput[]) {
  const accountIds = [...new Set(rules.map((rule) => rule.accountId))];
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM households WHERE id = ${householdId}::uuid FOR UPDATE`;
    if (accountIds.length > 0) {
      const found = await tx.account.count({ where: { id: { in: accountIds }, householdId, isActive: true } });
      if (found !== accountIds.length) throw new NotFoundError('Account');
    }
    await tx.captureCardRule.deleteMany({ where: { householdId } });
    if (rules.length > 0) {
      await tx.captureCardRule.createMany({
        data: rules.map((rule) => ({ householdId, package: rule.package, cardLast4: rule.cardLast4, accountId: rule.accountId })),
      });
    }
  });
  return listCardRules(householdId);
}

// ---------------------------------------------------------------------------------------------------------------
// Reparse
// ---------------------------------------------------------------------------------------------------------------

/** Upper bound of one reparse run; a personal household has a handful of drafts. A next run picks up the rest. */
const REPARSE_LIMIT = 1000;

/**
 * The captures a reparse may change: still waiting for the user (PENDING) or stored IGNORED by the first reader, and
 * read by an older parser (or never). CONFIRMED and DISMISSED are the user's decisions and are never touched.
 */
const REPARSABLE_STATUSES: Array<'PENDING' | 'IGNORED' | 'STUDY'> = ['PENDING', 'IGNORED', 'STUDY'];
const READ_BY_OLDER_PARSER: Prisma.CapturedNotificationWhereInput[] = [
  { parserVersion: null },
  { parserVersion: { lt: PARSER_VERSION } },
];

export interface ReparseResult {
  /** Captures found with an older reading. */
  scanned: number;
  /** Of those, how many this run wrote (a simultaneous run, or a confirm in between, takes the others). */
  updated: number;
  understood: number;
  dismissed: number;
  notUnderstood: number;
  parserVersion: number;
}

/**
 * Reads again, with the current parser, the captures read by an older one. A capture the parser no longer
 * understands loses its old reading; a notice becomes DISMISSED; an IGNORED capture now understood goes back to
 * PENDING. Each write is conditional on the status and the old version it was read with, so a second run (or a
 * simultaneous one) finds nothing to do and a draft confirmed or dismissed meanwhile is left alone.
 * Nothing is created or deleted; only `parsed`, `parser_version` and the status change.
 */
export async function reparseCaptures(householdId: string): Promise<ReparseResult> {
  const rows = await prisma.capturedNotification.findMany({
    // Only packages with a reader: a draft that carries its own reading (Open Finance) would lose it.
    where: { householdId, status: { in: REPARSABLE_STATUSES }, package: { in: [...PARSED_PACKAGES] }, OR: READ_BY_OLDER_PARSER },
    select: { id: true, package: true, title: true, text: true, status: true, dedupKey: true, postedAt: true },
    orderBy: CAPTURE_ORDER,
    take: REPARSE_LIMIT,
  });
  const result: ReparseResult = { scanned: rows.length, updated: 0, understood: 0, dismissed: 0, notUnderstood: 0, parserVersion: PARSER_VERSION };
  const reread: FreshCapture[] = [];
  for (const row of rows) {
    const parsed = parseCapture(row);
    const { count } = await prisma.capturedNotification.updateMany({
      where: { id: row.id, householdId, status: row.status, OR: READ_BY_OLDER_PARSER },
      data: {
        parsed: parsed ? (parsed as unknown as Prisma.InputJsonObject) : Prisma.DbNull,
        parserVersion: PARSER_VERSION,
        status: statusOfReading(parsed),
      },
    });
    if (count !== 1) continue;
    reread.push({ dedupKey: row.dedupKey, postedAt: row.postedAt, package: row.package, parsed });
    result.updated += 1;
    if (!parsed) result.notUnderstood += 1;
    else if (parsed.ignore) result.dismissed += 1;
    else result.understood += 1;
  }
  // A capture read again may now be the twin of another one (e.g. an app Pix sent that the older reader did not read).
  await dismissDuplicates(householdId, reread);
  return result;
}
