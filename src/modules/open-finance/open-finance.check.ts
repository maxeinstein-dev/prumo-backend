/**
 * Open Finance check (P25 L2a): for every linked BANK account, the last 30 days of the bank against what Prumo has,
 * WITHOUT writing anything. It answers what the import (L2b) would do: lines Prumo already has, lines missing in Prumo
 * (future drafts), moves between own accounts (future transfer drafts), lines that are internal or outside Prumo, and
 * Prumo transactions the bank does not show.
 *
 * Cards are not checked (their purchases come from the invoice OFX, decision 3). An item whose authorization expired
 * (Pluggy answers its lists empty) is reported as blocked and not read: empty is not "no movement".
 */
import { analyzeOpenFinance, ymd, type AnalyzeDb } from './open-finance.analyze.js';
import type { BankLine } from './open-finance.classify.js';
import { splitYields } from './open-finance.savings.js';
import type { PluggyClient } from './pluggy.client.js';

export const CHECK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type CheckDb = AnalyzeDb;

type LineView = Pick<BankLine, 'id' | 'date' | 'cents' | 'description' | 'savingsName'>;

export interface AccountCheck {
  pluggyAccountId: string;
  prumoAccountId: string;
  counts: { yield: number; savings: number; outside: number; passthrough: number; matched: number; missing: number };
  /** The savings' yield summed per month, and Prumo's share of it (null = a savings has no registered balance). */
  yieldsByMonth: Array<{ month: string; cents: number; prumoCents: number | null }>;
  missing: LineView[];
  outside: LineView[];
  onlyInPrumo: Array<{ id: string; type: string; date: string; cents: number; description: string | null; paid: boolean }>;
}

export interface CheckReport {
  from: string;
  to: string;
  items: Array<{ itemId: string; status: string | null; blocked: string | null }>;
  accounts: AccountCheck[];
  transfers: {
    matched: number;
    missing: Array<{
      date: string;
      cents: number;
      fromPrumoAccountId: string;
      toPrumoAccountId: string;
      outDescription: string;
      inDescription: string;
    }>;
  };
  /** Every savings name seen, so the user can tell which ones to ignore. */
  savingsNames: string[];
  cardsNotChecked: number;
  /** Accounts linked to an investment account of Prumo: checked by the investments part (L5), not here. */
  investmentsNotChecked: number;
}

const view = (l: BankLine): LineView => ({ id: l.id, date: l.date, cents: l.cents, description: l.description, savingsName: l.savingsName });

export async function checkOpenFinance(input: {
  householdId: string;
  db: CheckDb;
  client: PluggyClient;
  now?: Date;
  ignoredSavings: readonly string[];
}): Promise<CheckReport> {
  const now = input.now ?? new Date();
  const { from, to, links, items, lines, savings, result, cardsNotChecked, investmentsNotChecked } = await analyzeOpenFinance({
    householdId: input.householdId,
    db: input.db,
    client: input.client,
    from: ymd(new Date(now.getTime() - CHECK_DAYS * DAY_MS)),
    to: ymd(now),
    ignoredSavings: input.ignoredSavings,
  });

  const accounts: AccountCheck[] = links
    .filter((l) => lines.some((line) => line.pluggyAccountId === l.pluggyAccountId))
    .map((l) => {
      const own = (line: BankLine) => line.pluggyAccountId === l.pluggyAccountId;
      const mine = lines.filter(own);
      return {
        pluggyAccountId: l.pluggyAccountId,
        prumoAccountId: l.accountId,
        counts: {
          yield: mine.filter((x) => x.kind === 'yield').length,
          savings: mine.filter((x) => x.kind === 'savings').length,
          outside: mine.filter((x) => x.kind === 'outside').length,
          passthrough: mine.filter((x) => x.kind === 'passthrough').length,
          matched: result.matched.filter((m) => own(m.line)).length,
          missing: result.missing.filter(own).length,
        },
        yieldsByMonth: splitYields(mine, savings),
        missing: result.missing.filter(own).map(view),
        outside: mine.filter((x) => x.kind === 'outside').map(view),
        onlyInPrumo: result.onlyInPrumo
          .filter((p) => p.accountId === l.accountId || p.fromAccountId === l.accountId || p.toAccountId === l.accountId)
          .map((p) => ({ id: p.id, type: p.type, date: p.date, cents: p.cents, description: p.description, paid: p.paid })),
      };
    });

  return {
    from,
    to,
    items,
    accounts,
    transfers: {
      matched: result.matchedTransfers.length,
      missing: result.missingTransfers.map((tr) => ({
        date: tr.out.date,
        cents: -tr.out.cents,
        fromPrumoAccountId: tr.out.prumoAccountId,
        toPrumoAccountId: tr.in.prumoAccountId,
        outDescription: tr.out.description,
        inDescription: tr.in.description,
      })),
    },
    savingsNames: [...new Set(lines.map((l) => l.savingsName).filter((n): n is string => !!n))].sort((a, b) => a.localeCompare(b, 'pt-BR')),
    cardsNotChecked,
    investmentsNotChecked,
  };
}
