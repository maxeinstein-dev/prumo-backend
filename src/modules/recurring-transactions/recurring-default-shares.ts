import { Prisma } from '../../generated/prisma/client.js';
import { BadRequestError, NotFoundError } from '../../shared/errors/index.js';
import { defaultSplitParts, validateDefaultShares, type DefaultShareInput, type DefaultShareRule } from './default-split.js';

type Db = Prisma.TransactionClient;

/** How a default split is answered to the client. */
export interface DefaultShareDto {
  personId: string;
  personName: string;
  percent: number | null;
  amount: number | null;
}

/** `source` of a TransactionShare written from the default split of a recurrence (shown as "manual" to the client). */
export const RECURRING_SHARE_SOURCE = 'recurring';

const num = (value: { toNumber(): number } | null | undefined): number | null => (value ? value.toNumber() : null);

/**
 * Validates a default split typed by the user (shape and the people: each an active person of the household).
 * @throws BadRequestError / NotFoundError('Person')
 */
export async function assertDefaultSharesUsable(
  db: Db,
  householdId: string,
  entries: readonly DefaultShareInput[],
  /** On an edit: people already in the stored split. Deactivated since, they may stay (the occurrence skips them). */
  alreadyInSplit: ReadonlySet<string> = new Set(),
): Promise<void> {
  const problem = validateDefaultShares(entries);
  if (problem) throw new BadRequestError(problem);
  if (entries.length === 0) return;
  const people = await db.person.findMany({
    where: { householdId, id: { in: entries.map((e) => e.personId) } },
    select: { id: true, name: true, isActive: true },
  });
  const byId = new Map(people.map((p) => [p.id, p]));
  for (const entry of entries) {
    const person = byId.get(entry.personId);
    if (!person) throw new NotFoundError('Person');
    if (!person.isActive && !alreadyInSplit.has(person.id)) throw new BadRequestError(`${person.name} is inactive: reactivate the person before sharing with them`);
  }
}

/** Replaces the default split of a recurrence (an empty list removes it). Runs inside the caller's transaction. */
export async function replaceDefaultSharesInTx(db: Db, householdId: string, recurringId: string, entries: readonly DefaultShareInput[]): Promise<void> {
  await db.recurringTransactionShare.deleteMany({ where: { householdId, recurringTransactionId: recurringId } });
  if (entries.length === 0) return;
  await db.recurringTransactionShare.createMany({
    data: entries.map((entry) => ({
      householdId,
      recurringTransactionId: recurringId,
      personId: entry.personId,
      percent: entry.percent != null ? new Prisma.Decimal(entry.percent.toFixed(2)) : null,
      amount: entry.amount != null ? new Prisma.Decimal(entry.amount.toFixed(2)) : null,
    })),
  });
}

/** The default split of each recurrence, with the person names (one query for the rules, one for the names). */
export async function loadDefaultShares(db: Db, householdId: string, recurringIds: readonly string[]): Promise<Map<string, DefaultShareDto[]>> {
  const map = new Map<string, DefaultShareDto[]>();
  for (const id of recurringIds) map.set(id, []);
  if (recurringIds.length === 0) return map;
  const rows = await db.recurringTransactionShare.findMany({
    where: { householdId, recurringTransactionId: { in: [...recurringIds] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (rows.length === 0) return map;
  const people = await db.person.findMany({
    where: { householdId, id: { in: [...new Set(rows.map((r) => r.personId))] } },
    select: { id: true, name: true },
  });
  const names = new Map(people.map((p) => [p.id, p.name]));
  for (const row of rows) {
    map.get(row.recurringTransactionId)?.push({
      personId: row.personId,
      personName: names.get(row.personId) ?? '',
      percent: num(row.percent),
      amount: num(row.amount),
    });
  }
  return map;
}

/**
 * Writes the default split of the recurrence on one of its occurrences (generated, or an imported row it adopted),
 * inside the transaction that creates or links it. Only expenses are split (the part is what the person owes me).
 * Never touches a transaction that already has shares (a split made by hand wins), and never throws for the split
 * itself: an inactive person is skipped, a rule that does not fit gives no part.
 *
 * The transaction row is locked first (the same FOR UPDATE that PUT /people/:transactionId/shares takes), so a split
 * typed by hand at the same moment either lands before (and this sees it) or waits for this commit.
 * @returns how many shares were written
 */
export async function applyDefaultSharesInTx(
  db: Db,
  householdId: string,
  recurringId: string,
  transaction: { id: string; type: string; amount: { toNumber(): number } | number },
): Promise<number> {
  if (transaction.type !== 'EXPENSE') return 0;
  const rules = await db.recurringTransactionShare.findMany({
    where: { householdId, recurringTransactionId: recurringId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (rules.length === 0) return 0;

  await db.$queryRaw`SELECT id FROM transactions WHERE id = ${transaction.id}::uuid FOR UPDATE`;
  const existing = await db.transactionShare.findFirst({ where: { transactionId: transaction.id }, select: { id: true } });
  if (existing) return 0;

  const people = await db.person.findMany({
    where: { householdId, id: { in: rules.map((r) => r.personId) }, isActive: true },
    select: { id: true },
  });
  const amount = typeof transaction.amount === 'number' ? transaction.amount : transaction.amount.toNumber();
  const parts = defaultSplitParts(
    Math.round(amount * 100),
    rules.map<DefaultShareRule>((r) => ({ personId: r.personId, percent: num(r.percent), amount: num(r.amount) })),
    new Set(people.map((p) => p.id)),
  );
  if (parts.length === 0) return 0;
  await db.transactionShare.createMany({
    data: parts.map((part) => ({
      householdId,
      transactionId: transaction.id,
      personId: part.personId,
      amount: new Prisma.Decimal((part.amountCents / 100).toFixed(2)),
      direction: 'THEY_OWE_ME' as const,
      source: RECURRING_SHARE_SOURCE,
    })),
  });
  return parts.length;
}
