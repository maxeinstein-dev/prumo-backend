/**
 * Pure rules of the Open Finance check (P25 L2): what each bank line of a linked account is, which lines are moves
 * between the household's own accounts, and which Prumo transaction (if any) each line already is.
 *
 * Bank account lines (decisions of 27/11/2026):
 * - "Rendimentos" (daily yield of the savings): ignored ("yield").
 * - "Dinheiro reservado/retirado [name]": the money moving between the account and one of its savings ("savings"),
 *   never a draft. The savings side carries the savings' name; the account side has none.
 * - A payment made with money just withdrawn from an ignored savings (e.g. one that stays outside Prumo), or money
 *   received and put straight into one, is "outside": not Prumo's money.
 * - Everything else is a "candidate" (a draft unless Prumo already has it).
 *
 * Matching (bank values are exact, so to the cent): an outflow of account P is an EXPENSE of P or a TRANSFER out of P;
 * an inflow an INCOME of P or a TRANSFER into P; up to 3 days apart, closest date first, one to one. A pair of lines
 * between two linked accounts is matched as one TRANSFER between them.
 */
import type { PluggyTransaction } from './pluggy.client.js';

export type LineKind = 'yield' | 'savings' | 'outside' | 'candidate';

export interface BankLine {
  /** Pluggy transaction id. */
  id: string;
  pluggyAccountId: string;
  prumoAccountId: string;
  /** 'YYYY-MM-DD' */
  date: string;
  /** Signed cents: negative = money out of the account. */
  cents: number;
  description: string;
  kind: LineKind;
  /** The savings the money came from / went to, when known. */
  savingsName: string | null;
}

export interface OwnTransfer {
  out: BankLine;
  in: BankLine;
}

export interface PrumoTx {
  id: string;
  type: 'INCOME' | 'EXPENSE' | 'TRANSFER' | 'ALLOCATION';
  accountId: string | null;
  fromAccountId: string | null;
  toAccountId: string | null;
  /** Positive cents. */
  cents: number;
  /** 'YYYY-MM-DD' */
  date: string;
  description: string | null;
  paid: boolean;
}

export const MATCH_DAYS = 3;
/** A withdrawal from a savings may be smaller than the payment (the rest was already in the account): up to R$ 1. */
const SAVINGS_SLACK_CENTS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

const YIELD = /^rendimentos?\b/i;
const SAVINGS = /^dinheiro (retirado|reservado)\b\s*(.*)$/i;

const fold = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

const toCents = (amount: number): number => Math.round(amount * 100);

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);
}

export function classifyAccount(
  transactions: readonly PluggyTransaction[],
  options: { prumoAccountId: string; ignoredSavings: readonly string[] },
): BankLine[] {
  const ignored = new Set(options.ignoredSavings.map(fold));
  const lines: BankLine[] = transactions.map((t) => {
    const description = t.description.trim();
    const savings = SAVINGS.exec(description);
    return {
      id: t.id,
      pluggyAccountId: t.accountId,
      prumoAccountId: options.prumoAccountId,
      date: t.date,
      cents: toCents(t.amount),
      description,
      kind: YIELD.test(description) ? 'yield' : savings ? 'savings' : 'candidate',
      savingsName: savings && savings[2].trim() ? savings[2].trim() : null,
    };
  });

  // The savings side of each move: a named "retirado" brings money in (+), a named "reservado" takes it out (-).
  const used = new Set<string>();
  const sourceFor = (line: BankLine): BankLine | undefined => {
    const want = line.cents < 0 ? /^dinheiro retirado/i : /^dinheiro reservado/i;
    const size = Math.abs(line.cents);
    return lines.find(
      (s) =>
        s.kind === 'savings' &&
        s.savingsName &&
        !used.has(s.id) &&
        s.date === line.date &&
        want.test(s.description) &&
        Math.sign(s.cents) === -Math.sign(line.cents) &&
        Math.abs(s.cents) <= size &&
        Math.abs(s.cents) >= size - SAVINGS_SLACK_CENTS,
    );
  };

  for (const line of lines) {
    if (line.kind !== 'candidate') continue;
    const source = sourceFor(line);
    if (!source) continue;
    used.add(source.id);
    line.savingsName = source.savingsName;
    if (ignored.has(fold(source.savingsName!))) line.kind = 'outside';
  }
  return lines;
}

export function pairOwnTransfers(lines: readonly BankLine[]): { transfers: OwnTransfer[]; rest: BankLine[] } {
  const paired = new Set<string>();
  const transfers: OwnTransfer[] = [];
  for (const out of lines) {
    if (out.kind !== 'candidate' || out.cents >= 0 || paired.has(out.id)) continue;
    const match = lines
      .filter(
        (inn) =>
          inn.kind === 'candidate' &&
          !paired.has(inn.id) &&
          inn.cents === -out.cents &&
          inn.pluggyAccountId !== out.pluggyAccountId &&
          inn.prumoAccountId !== out.prumoAccountId &&
          Math.abs(dayDiff(inn.date, out.date)) <= 1,
      )
      .sort((a, b) => Math.abs(dayDiff(a.date, out.date)) - Math.abs(dayDiff(b.date, out.date)))[0];
    if (!match) continue;
    paired.add(out.id);
    paired.add(match.id);
    transfers.push({ out, in: match });
  }
  return { transfers, rest: lines.filter((l) => !paired.has(l.id)) };
}

export function matchWithPrumo(input: {
  lines: readonly BankLine[];
  transfers: readonly OwnTransfer[];
  prumo: readonly PrumoTx[];
  from: string;
  to: string;
}) {
  const used = new Set<string>();
  const closest = (date: string, fits: (p: PrumoTx) => boolean): PrumoTx | undefined =>
    input.prumo
      .filter((p) => !used.has(p.id) && Math.abs(dayDiff(p.date, date)) <= MATCH_DAYS && fits(p))
      .sort((a, b) => Math.abs(dayDiff(a.date, date)) - Math.abs(dayDiff(b.date, date)))[0];

  const matchedTransfers: Array<{ transfer: OwnTransfer; transactionId: string }> = [];
  const missingTransfers: OwnTransfer[] = [];
  for (const transfer of input.transfers) {
    const hit = closest(
      transfer.out.date,
      (p) =>
        p.type === 'TRANSFER' &&
        p.cents === -transfer.out.cents &&
        p.fromAccountId === transfer.out.prumoAccountId &&
        p.toAccountId === transfer.in.prumoAccountId,
    );
    if (hit) {
      used.add(hit.id);
      matchedTransfers.push({ transfer, transactionId: hit.id });
    } else {
      missingTransfers.push(transfer);
    }
  }

  const matched: Array<{ line: BankLine; transactionId: string }> = [];
  const missing: BankLine[] = [];
  for (const line of input.lines) {
    const account = line.prumoAccountId;
    const cents = Math.abs(line.cents);
    const hit = closest(line.date, (p) =>
      p.cents === cents &&
      (line.cents < 0
        ? (p.type === 'EXPENSE' && p.accountId === account) || (p.type === 'TRANSFER' && p.fromAccountId === account)
        : (p.type === 'INCOME' && p.accountId === account) || (p.type === 'TRANSFER' && p.toAccountId === account)),
    );
    if (hit) {
      used.add(hit.id);
      matched.push({ line, transactionId: hit.id });
    } else {
      missing.push(line);
    }
  }

  const onlyInPrumo = input.prumo.filter((p) => !used.has(p.id) && p.date >= input.from && p.date <= input.to);
  return { matched, missing, matchedTransfers, missingTransfers, onlyInPrumo };
}
