/**
 * Open Finance check (P25 L2a): for every linked BANK account, the last 30 days of the bank against what Prumo has,
 * WITHOUT writing anything. It answers what the import (L2b) would do: lines Prumo already has, lines missing in Prumo
 * (future drafts), moves between own accounts (future transfer drafts), lines that are internal or outside Prumo, and
 * Prumo transactions the bank does not show.
 *
 * Cards are not checked (their purchases come from the invoice OFX, decision 3). An item whose authorization expired
 * (Pluggy answers its lists empty) is reported as blocked and not read: empty is not "no movement".
 */
import { classifyAccount, matchWithPrumo, pairOwnTransfers, type BankLine, type PrumoTx } from './open-finance.classify.js';
import { MATCH_DAYS } from './open-finance.classify.js';
import { PluggyError, type PluggyClient } from './pluggy.client.js';

export const CHECK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CheckDb {
  openFinanceLink: {
    findMany(args: unknown): Promise<Array<{ pluggyItemId: string; pluggyAccountId: string | null; accountId: string | null }>>;
  };
  account: { findMany(args: unknown): Promise<Array<{ id: string; type: string }>> };
  transaction: {
    findMany(args: unknown): Promise<
      Array<{
        id: string;
        type: string;
        accountId: string | null;
        fromAccountId: string | null;
        toAccountId: string | null;
        amount: unknown;
        date: Date;
        description: string | null;
        paid: boolean;
      }>
    >;
  };
}

type LineView = Pick<BankLine, 'id' | 'date' | 'cents' | 'description' | 'savingsName'>;

export interface AccountCheck {
  pluggyAccountId: string;
  prumoAccountId: string;
  counts: { yield: number; savings: number; outside: number; passthrough: number; matched: number; missing: number };
  /** The savings' yield summed per month (the import makes one draft per month). */
  yieldsByMonth: Array<{ month: string; cents: number }>;
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

const ymd = (date: Date): string => date.toISOString().slice(0, 10);
const view = (l: BankLine): LineView => ({ id: l.id, date: l.date, cents: l.cents, description: l.description, savingsName: l.savingsName });

function blockedText(status: string, executionStatus: string | null): string | null {
  if (executionStatus === 'USER_AUTHORIZATION_EXPIRED' || status === 'LOGIN_ERROR') {
    return 'A autorização deste banco venceu: reconecte no Meu Pluggy.';
  }
  if (status === 'WAITING_USER_INPUT') return 'O banco espera uma ação no Meu Pluggy antes de atualizar.';
  return null;
}

const isFatal = (e: unknown) => e instanceof PluggyError && (e.kind === 'auth' || e.kind === 'not_configured');

export async function checkOpenFinance(input: {
  householdId: string;
  db: CheckDb;
  client: PluggyClient;
  now?: Date;
  ignoredSavings: readonly string[];
}): Promise<CheckReport> {
  const now = input.now ?? new Date();
  const from = ymd(new Date(now.getTime() - CHECK_DAYS * DAY_MS));
  const to = ymd(now);

  const links = (
    await input.db.openFinanceLink.findMany({
      where: { householdId: input.householdId },
      select: { pluggyItemId: true, pluggyAccountId: true, accountId: true },
      orderBy: { createdAt: 'asc' },
    })
  ).filter((l): l is { pluggyItemId: string; pluggyAccountId: string; accountId: string } => !!l.pluggyAccountId && !!l.accountId);

  const items: CheckReport['items'] = [];
  const lines: BankLine[] = [];
  let cardsNotChecked = 0;
  let investmentsNotChecked = 0;
  const prumoTypes = new Map(
    (links.length
      ? await input.db.account.findMany({
          where: { id: { in: [...new Set(links.map((l) => l.accountId))] }, householdId: input.householdId },
          select: { id: true, type: true },
        })
      : []
    ).map((a) => [a.id, a.type]),
  );

  for (const itemId of [...new Set(links.map((l) => l.pluggyItemId))]) {
    let accounts;
    try {
      const item = await input.client.getItem(itemId);
      const blocked = blockedText(item.status, item.executionStatus);
      items.push({ itemId, status: item.status, blocked });
      if (blocked) continue;
      accounts = await input.client.listAccounts(itemId);
    } catch (e) {
      if (isFatal(e) || !(e instanceof PluggyError)) throw e;
      items.push({ itemId, status: null, blocked: e.message });
      continue;
    }
    for (const link of links.filter((l) => l.pluggyItemId === itemId)) {
      const account = accounts.find((a) => a.id === link.pluggyAccountId);
      if (!account) continue;
      if (account.type === 'CREDIT') {
        cardsNotChecked++;
        continue;
      }
      if (prumoTypes.get(link.accountId) === 'INVESTMENT') {
        investmentsNotChecked++;
        continue;
      }
      const transactions = await input.client.listTransactions(account.id, { from, to });
      lines.push(...classifyAccount(transactions, { prumoAccountId: link.accountId, ignoredSavings: input.ignoredSavings }));
    }
  }

  const prumoAccounts = [...new Set(lines.map((l) => l.prumoAccountId))];
  if (prumoAccounts.length === 0) {
    return { from, to, items, accounts: [], transfers: { matched: 0, missing: [] }, savingsNames: [], cardsNotChecked, investmentsNotChecked };
  }

  const margin = MATCH_DAYS * DAY_MS;
  const rows = await input.db.transaction.findMany({
    where: {
      householdId: input.householdId,
      date: { gte: new Date(`${ymd(new Date(Date.parse(`${from}T00:00:00Z`) - margin))}T00:00:00Z`), lte: new Date(`${ymd(new Date(Date.parse(`${to}T00:00:00Z`) + margin))}T00:00:00Z`) },
      OR: [{ accountId: { in: prumoAccounts } }, { fromAccountId: { in: prumoAccounts } }, { toAccountId: { in: prumoAccounts } }],
    },
    select: { id: true, type: true, accountId: true, fromAccountId: true, toAccountId: true, amount: true, date: true, description: true, paid: true },
  });
  const prumo: PrumoTx[] = rows.map((r) => ({
    id: r.id,
    type: r.type as PrumoTx['type'],
    accountId: r.accountId,
    fromAccountId: r.fromAccountId,
    toAccountId: r.toAccountId,
    cents: Math.abs(Math.round(Number(r.amount) * 100)),
    date: ymd(r.date),
    description: r.description,
    paid: r.paid,
  }));

  const { transfers, rest } = pairOwnTransfers(lines);
  const candidates = rest.filter((l) => l.kind === 'candidate');
  const result = matchWithPrumo({ lines: candidates, passthrough: rest.filter((l) => l.kind === 'passthrough'), transfers, prumo, from, to });

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
        yieldsByMonth: yieldsByMonth(mine),
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

function yieldsByMonth(lines: readonly BankLine[]): Array<{ month: string; cents: number }> {
  const sums = new Map<string, number>();
  for (const line of lines) {
    if (line.kind !== 'yield') continue;
    const month = line.date.slice(0, 7);
    sums.set(month, (sums.get(month) ?? 0) + line.cents);
  }
  return [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([month, cents]) => ({ month, cents }));
}
