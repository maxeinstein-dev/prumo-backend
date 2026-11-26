import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError, ConflictError } from '../../shared/errors/app-error.js';
import { AccountType, CategoryName, TransactionType } from '../../shared/enums/index.js';
import { parseCsvStatement } from './parsers/csv.parser.js';
import { isCardStatementOfx } from './parsers/ofx-card.parser.js';
import { parseOfxStatement } from './parsers/ofx.parser.js';
import { decodeStatement, type ParsedRow, type ParseResult, type SkippedRow } from './parsers/statement.common.js';
import { createTransaction } from './transactions.service.js';

export type { ParsedRow };

/** The preview lists at most this many skipped lines; `skippedCount` always has the real total. */
const MAX_LISTED_SKIPPED = 100;

export interface ImportPreviewRow extends ParsedRow {
  index: number;
  duplicate: boolean;
}

export interface ImportPreview {
  rows: ImportPreviewRow[];
  total: number;
  duplicateCount: number;
  newCount: number;
  /** Lines of the file that could not be read, with the reason, so nothing disappears silently. */
  skipped: SkippedRow[];
  skippedCount: number;
}

export interface ConfirmImportResult {
  imported: number;
  skipped: number;
  ids: string[];
}

/** Tolerance for in-memory amount comparison (half a cent). */
const AMOUNT_TOLERANCE = 0.005;

/**
 * Pure helper: day window for a parsed row, both bounds the UTC-midnight Date of the day the row is stored on.
 * Transaction.date is @db.Date (day precision) and the driver stores the UTC date part of the instant, so dedup must
 * ignore the time component that OFX/CSV parsers may include and compare that same day. A 23:59:59.999 end bound
 * would be the next day in UTC in time zones behind it, and a purchase would match a duplicate from the next day.
 */
export function getDayRange(date: Date): { start: Date; end: Date } {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  return { start: day, end: new Date(day) };
}

/**
 * Pure helper: float-safe amount comparison for unit tests and docs.
 * The DB query below uses exact Prisma.Decimal equality instead, which is
 * correct because Postgres `numeric` comparison is scale-insensitive
 * (89.9 = 89.90) and import duplicates always originate from the same
 * parser path (same JS number -> same Decimal -> same numeric value).
 */
export function amountsEqual(a: number, b: number, tolerance = AMOUNT_TOLERANCE): boolean {
  return Math.abs(a - b) <= tolerance;
}

/**
 * Parse an uploaded statement file. Selects the parser by extension.
 * @throws BadRequestError (400) for unsupported extensions or a CSV header that names no columns.
 */
export function parseImportBuffer(filename: string, buffer: Buffer): ParseResult {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';

  if (ext !== '.ofx' && ext !== '.csv') {
    throw new BadRequestError(
      `Unsupported file type "${ext || filename}". Only .ofx and .csv files are accepted.`,
    );
  }

  const text = decodeStatement(buffer);
  const parsed = ext === '.ofx' ? parseOfxStatement(text) : parseCsvStatement(text);

  if (parsed.rows.length === 0 && parsed.skipped.length === 0) {
    throw new BadRequestError('No readable transactions found in the file.');
  }

  return parsed;
}

/**
 * A credit card invoice (an OFX holding CCSTMTRS) sent to a CREDIT account must go through the card importer:
 * stored as raw statement rows it would duplicate everything the monthly sheet already put on the card.
 * @throws BadRequestError (400) pointing to POST /transactions/import/card-ofx/preview.
 */
export function assertNotCardInvoice(accountType: string, filename: string, buffer: Buffer): void {
  if (accountType !== AccountType.CREDIT || !filename.toLowerCase().endsWith('.ofx')) return;
  // The tag is ASCII: any single-byte reading finds it, whatever the file's encoding.
  if (!isCardStatementOfx(buffer.toString('latin1'))) return;
  throw new BadRequestError(
    'This OFX is a credit card invoice (CCSTMTRS): import it with POST /transactions/import/card-ofx/preview, ' +
      'which reconciles it with the transactions already on the card instead of duplicating them.',
  );
}

const dayKey = (date: Date) => date.toISOString().slice(0, 10);

/** Two rows are "the same transaction" when type, day, amount in cents and description match. */
function rowKey(type: string, date: Date, amount: number | Prisma.Decimal, description: string | null): string {
  const cents = Math.round(Number(amount) * 100);
  return `${type}|${dayKey(date)}|${cents}|${description ?? ''}`;
}

/**
 * Which rows already exist on the account, comparing by occurrence: when the file holds the same row three times and
 * the account already has two of it, the first two are duplicates and the third is new. Comparing only "does one
 * exist" would drop the second of two identical purchases (two coffees on the same day) without a word.
 * One query for the whole file. Preview and confirm both use it, so they always agree.
 */
export async function flagDuplicates(
  accountId: string,
  householdId: string,
  rows: ParsedRow[],
): Promise<boolean[]> {
  if (rows.length === 0) return [];
  let min = rows[0]!.date;
  let max = rows[0]!.date;
  for (const row of rows) {
    if (row.date < min) min = row.date;
    if (row.date > max) max = row.date;
  }

  const existing = await prisma.transaction.findMany({
    where: { householdId, accountId, date: { gte: min, lte: max }, type: { in: ['INCOME', 'EXPENSE'] } },
    select: { type: true, date: true, amount: true, description: true },
  });
  const stored = new Map<string, number>();
  for (const tx of existing) {
    const key = rowKey(tx.type, tx.date, tx.amount, tx.description);
    stored.set(key, (stored.get(key) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = rowKey(row.type, row.date, row.amount, row.description);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return occurrence <= (stored.get(key) ?? 0);
  });
}

export async function buildImportPreview(
  accountId: string,
  householdId: string,
  parsed: ParseResult,
): Promise<ImportPreview> {
  const flags = await flagDuplicates(accountId, householdId, parsed.rows);
  const rows: ImportPreviewRow[] = parsed.rows.map((row, index) => ({
    ...row,
    index,
    duplicate: flags[index] === true,
  }));
  const duplicateCount = flags.filter(Boolean).length;
  return {
    rows,
    total: rows.length,
    duplicateCount,
    newCount: rows.length - duplicateCount,
    skipped: parsed.skipped.slice(0, MAX_LISTED_SKIPPED),
    skippedCount: parsed.skipped.length,
  };
}

/**
 * Persist the rows that are not already on the account. Send the whole file, duplicates included: the rows already on
 * the account are found with the same rule as the preview (by occurrence), which only gives the preview's answer when
 * it sees the same list.
 *
 * A per-account advisory lock serialises confirms: two requests with the same file (a double click, or a retry after
 * the browser gave up waiting) cannot both see "not there yet" and import it twice. The lock lives in a transaction
 * that does nothing else, because createTransaction owns its own database transaction (and balance update) on another
 * connection and cannot join this one. The lock is only tried, never waited for: a waiting request would hold a pool
 * connection for the whole import ahead of it. A second confirm on the same account gets 409 right away instead.
 *
 * The rows are not atomic: if one fails, the rows before it stay saved and the error is thrown; sending the same file
 * again continues from there, because the saved rows now count as duplicates.
 */
export async function confirmImport(
  accountId: string,
  householdId: string,
  rows: ParsedRow[],
  userId?: string,
): Promise<ConfirmImportResult> {
  return prisma.$transaction(
    async (lock) => {
      const [{ locked }] = await lock.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${`statement-import:${accountId}`})) AS locked`;
      if (!locked) throw new ConflictError('An import is already running for this account.');

      const flags = await flagDuplicates(accountId, householdId, rows);
      const ids: string[] = [];
      let skipped = 0;

      for (let index = 0; index < rows.length; index++) {
        const row = rows[index] as ParsedRow;
        if (flags[index]) {
          skipped += 1;
          continue;
        }
        const created = await createTransaction(
          {
            householdId,
            accountId,
            type: row.type === 'INCOME' ? TransactionType.INCOME : TransactionType.EXPENSE,
            categoryName: row.type === 'INCOME' ? CategoryName.OTHER_INCOME : CategoryName.OTHER_EXPENSES,
            amount: row.amount,
            description: row.description,
            date: row.date,
            paid: true,
            isSplit: false,
          },
          userId,
        );
        ids.push(created.id);
      }

      return { imported: ids.length, skipped, ids };
    },
    // The loop can run for minutes on a large file; the default 5 s would abort it midway.
    { timeout: 10 * 60 * 1000, maxWait: 30 * 1000 },
  );
}
