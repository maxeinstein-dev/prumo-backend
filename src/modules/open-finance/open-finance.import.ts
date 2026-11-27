/**
 * Open Finance import (P25 L2b2). Run daily by the job (L2c) or by hand (POST /open-finance/import). For every linked
 * bank account (decisions of 27/11/2026):
 *
 * - Lines Prumo already has get a reference (`TransactionExternalRef`, ref `pluggy:<id>`): nothing else is written.
 * - Lines missing in Prumo become drafts in the captures box (package 'open-finance', the Prumo account already in the
 *   reading), but only from the day the import started for that account (`import_from`, set on the first run): the
 *   past is only checked, never drafted.
 * - A move between two linked accounts becomes one transfer draft: two captures with the same pairKey (the box offers
 *   them together, see capture-transfer).
 * - The savings' yield becomes one income draft per closed month, with Prumo's share only (open-finance.savings);
 *   never for the month the import started in, nor when the share is unknown.
 * - An item whose authorization expired is not read; its links keep the reason in `last_error`.
 *
 * - A line whose notification is still waiting in the box is not drafted (the next run sees it again).
 *
 * Idempotent: lines already referenced or drafted are left out, Prumo transactions already referenced are never offered
 * to another line, and every write skips duplicates (`dedupKey` and `ref` are unique per household).
 */
import { createHash } from 'node:crypto';

import { PARSER_VERSION } from '../captures/parsers/index.js';
import { OPEN_FINANCE_PACKAGE } from '../captures/open-finance-package.js';
import { analyzeOpenFinance, ymd, type AnalyzeDb } from './open-finance.analyze.js';
import type { BankLine } from './open-finance.classify.js';
import { splitYields } from './open-finance.savings.js';
import type { PluggyClient } from './pluggy.client.js';

export const IMPORT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const REF_PREFIX = 'pluggy:';
const DRAFT_TITLE = 'Open Finance';

export interface ImportDb extends AnalyzeDb {
  openFinanceLink: AnalyzeDb['openFinanceLink'] & { update(args: unknown): Promise<unknown> };
  transactionExternalRef: {
    findMany(args: unknown): Promise<Array<{ ref: string; transactionId: string }>>;
    createMany(args: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }): Promise<unknown>;
  };
  capturedNotification: {
    findMany(args: unknown): Promise<Array<{ dedupKey: string; package?: string; status?: string; postedAt?: Date; parsed?: unknown }>>;
    createMany(args: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }): Promise<unknown>;
  };
  householdMember: { findFirst(args: unknown): Promise<{ userId: string } | null> };
}

export interface ImportResult {
  refs: number;
  drafts: number;
  transferDrafts: number;
  yieldDrafts: number;
  blocked: Array<{ itemId: string; reason: string }>;
}

/** dedupKey of the draft of a bank line (VarChar(40)): 'of:' + the Pluggy id, or a hash of it when too long. */
export function draftKey(lineId: string): string {
  const key = `of:${lineId}`;
  return key.length <= 40 ? key : `of:${createHash('sha1').update(lineId).digest('hex').slice(0, 37)}`;
}

const yieldKey = (prumoAccountId: string, month: string) => `of:y:${prumoAccountId.slice(0, 8)}:${month}`;
const postedAt = (date: string) => new Date(`${date}T15:00:00.000Z`); // noon in Brasília: the bank gives only the day

function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function previousMonthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
}

function reading(line: BankLine, extra: Record<string, unknown> = {}) {
  const cents = Math.abs(line.cents);
  return {
    kind: line.cents < 0 ? 'PIX_OUT' : 'PIX_IN',
    type: line.cents < 0 ? 'EXPENSE' : 'INCOME',
    amountCents: cents,
    amount: cents / 100,
    description: line.description,
    accountId: line.prumoAccountId,
    source: 'open-finance',
    pluggyTransactionId: line.id,
    ...(line.savingsName ? { savingsName: line.savingsName } : {}),
    ...extra,
  };
}

export async function importOpenFinance(input: {
  householdId: string;
  db: ImportDb;
  client: PluggyClient;
  now?: Date;
}): Promise<ImportResult> {
  const { householdId, db } = input;
  const now = input.now ?? new Date();
  const today = ymd(now);
  const thirtyDays = ymd(new Date(now.getTime() - IMPORT_DAYS * DAY_MS));
  // The whole previous month is read too, for its yield draft.
  const from = [thirtyDays, previousMonthStart(now)].sort()[0];

  const knownRefs = await db.transactionExternalRef.findMany({
    where: { householdId, ref: { startsWith: REF_PREFIX } },
    select: { ref: true, transactionId: true },
  });
  const referencedLines = new Set(knownRefs.map((r) => r.ref.slice(REF_PREFIX.length)));
  const knownDrafts = new Set(
    (await db.capturedNotification.findMany({ where: { householdId, package: OPEN_FINANCE_PACKAGE }, select: { dedupKey: true } })).map(
      (c) => c.dedupKey,
    ),
  );

  const analysis = await analyzeOpenFinance({
    householdId,
    db,
    client: input.client,
    from,
    to: today,
    handled: (line) => referencedLines.has(line.id) || knownDrafts.has(draftKey(line.id)),
    takenTransactionIds: new Set(knownRefs.map((r) => r.transactionId)),
  });
  const { result, savings } = analysis;

  // Start of the drafts per account: today on the first run.
  const startOf = new Map<string, string>();
  for (const link of analysis.readLinks) {
    let start = link.importFrom ? ymd(link.importFrom) : null;
    if (!start) {
      start = today;
      await db.openFinanceLink.update({ where: { id: link.id }, data: { importFrom: new Date(`${today}T00:00:00Z`) } });
    }
    startOf.set(link.pluggyAccountId, start);
  }
  const draftable = (line: BankLine) => {
    const start = startOf.get(line.pluggyAccountId);
    return !!start && line.date >= start;
  };

  // References for what Prumo already has (any day of the period).
  const refRows = [
    ...result.matched.map((m) => ({ line: m.line, transactionId: m.transactionId })),
    ...result.matchedPassthrough.map((m) => ({ line: m.line, transactionId: m.transactionId })),
    ...result.matchedTransfers.flatMap((m) => [
      { line: m.transfer.out, transactionId: m.transactionId },
      { line: m.transfer.in, transactionId: m.transactionId },
    ]),
  ].map(({ line, transactionId }) => ({ householdId, transactionId, ref: `${REF_PREFIX}${line.id}` }));

  // Notifications still waiting in the box (not yet a transaction): the same move must not get a second draft. The line
  // is left for the next run, when the notification is either confirmed (then referenced) or dismissed (then drafted).
  const waiting = (
    await db.capturedNotification.findMany({
      where: {
        householdId,
        status: 'PENDING',
        postedAt: { gte: new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS), lte: new Date(Date.parse(`${today}T00:00:00Z`) + 2 * DAY_MS) },
      },
      select: { dedupKey: true, package: true, status: true, postedAt: true, parsed: true },
    })
  ).filter((c) => c.package !== OPEN_FINANCE_PACKAGE && c.status === 'PENDING' && c.postedAt);
  const usedWaiting = new Set<string>();
  const waitingInBox = (line: BankLine): boolean => {
    const type = line.cents < 0 ? 'EXPENSE' : 'INCOME';
    const hit = waiting.find((c) => {
      const parsed = (c.parsed ?? {}) as Record<string, unknown>;
      // The device's day in Brasília (UTC-3).
      const day = ymd(new Date(c.postedAt!.getTime() - 3 * 60 * 60 * 1000));
      return (
        !usedWaiting.has(c.dedupKey) &&
        parsed.type === type &&
        parsed.amountCents === Math.abs(line.cents) &&
        Math.abs(Date.parse(`${day}T00:00:00Z`) - Date.parse(`${line.date}T00:00:00Z`)) <= DAY_MS
      );
    });
    if (hit) usedWaiting.add(hit.dedupKey);
    return !!hit;
  };

  // Drafts.
  const captures: Array<Record<string, unknown>> = [];
  let drafts = 0;
  let transferDrafts = 0;
  let yieldDrafts = 0;
  for (const line of result.missing) {
    if (!draftable(line) || waitingInBox(line)) continue;
    captures.push({ dedupKey: draftKey(line.id), text: line.description, postedAt: postedAt(line.date), parsed: reading(line) });
    drafts++;
  }
  for (const transfer of result.missingTransfers) {
    if (!draftable(transfer.out) || !draftable(transfer.in)) continue;
    const pairKey = draftKey(transfer.out.id);
    const at = postedAt(transfer.out.date);
    captures.push({ dedupKey: draftKey(transfer.out.id), text: transfer.out.description, postedAt: at, parsed: reading(transfer.out, { pairKey }) });
    captures.push({
      dedupKey: draftKey(transfer.in.id),
      text: transfer.in.description,
      postedAt: at,
      parsed: reading(transfer.in, { pairKey, warning: 'POSSIBLE_OWN_TRANSFER' }),
    });
    transferDrafts++;
  }
  const currentMonth = today.slice(0, 7);
  for (const link of analysis.readLinks) {
    const start = startOf.get(link.pluggyAccountId)!;
    const mine = analysis.lines.filter((l) => l.pluggyAccountId === link.pluggyAccountId);
    for (const month of splitYields(mine, savings)) {
      if (month.month >= currentMonth || `${month.month}-01` < start) continue;
      if (!month.prumoCents || month.prumoCents <= 0) continue;
      const key = yieldKey(link.accountId, month.month);
      if (knownDrafts.has(key)) continue;
      const [y, m] = month.month.split('-');
      const description = `Rendimentos dos cofrinhos em ${m}/${y}`;
      captures.push({
        dedupKey: key,
        text: description,
        postedAt: postedAt(lastDayOf(month.month)),
        parsed: {
          kind: 'PIX_IN',
          type: 'INCOME',
          amountCents: month.prumoCents,
          amount: month.prumoCents / 100,
          description,
          accountId: link.accountId,
          source: 'open-finance',
          yieldMonth: month.month,
        },
      });
      yieldDrafts++;
    }
  }

  if (refRows.length > 0) await db.transactionExternalRef.createMany({ data: refRows, skipDuplicates: true });
  if (captures.length > 0) {
    const owner = await db.householdMember.findFirst({
      where: { householdId, role: 'OWNER' },
      orderBy: { createdAt: 'asc' },
      select: { userId: true },
    });
    if (!owner) throw new Error('The household has no owner to receive the Open Finance drafts');
    await db.capturedNotification.createMany({
      data: captures.map((c) => ({
        householdId,
        userId: owner.userId,
        package: OPEN_FINANCE_PACKAGE,
        title: DRAFT_TITLE,
        status: 'PENDING',
        parserVersion: PARSER_VERSION,
        ...c,
        text: String(c.text).slice(0, 2000),
      })),
      skipDuplicates: true,
    });
  }

  // Sync state of every link: the error of a blocked item, or a clean sync.
  const blocked = analysis.items.filter((i) => i.blocked).map((i) => ({ itemId: i.itemId, reason: i.blocked! }));
  for (const link of analysis.links) {
    const reason = blocked.find((b) => b.itemId === link.pluggyItemId)?.reason ?? null;
    await db.openFinanceLink.update({ where: { id: link.id }, data: reason ? { lastError: reason } : { lastSyncAt: now, lastError: null } });
  }

  return { refs: refRows.length, drafts, transferDrafts, yieldDrafts, blocked };
}
