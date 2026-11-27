/**
 * The common part of the Open Finance check (L2a) and import (L2b2): read the linked BANK accounts of every item (an
 * item whose authorization expired is reported, not read), classify their lines, pair the moves between own accounts
 * and match everything with the Prumo transactions around the period. Reads only.
 *
 * `handled` lines (already referenced or already drafted by an earlier import) stay out of pairing and matching, and
 * `takenTransactionIds` (Prumo transactions already referenced) are never offered to another line.
 */
import { classifyAccount, matchWithPrumo, MATCH_DAYS, pairOwnTransfers, type BankLine, type PrumoTx } from './open-finance.classify.js';
import { ignoredSavingsNames, type SavingsConfig } from './open-finance.savings.js';
import { listSavings } from './open-finance.savings.service.js';
import { PluggyError, type PluggyClient } from './pluggy.client.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AnalyzeLink {
  id?: string;
  pluggyItemId: string;
  pluggyAccountId: string;
  accountId: string;
  importFrom?: Date | null;
}

export interface AnalyzeDb {
  openFinanceLink: { findMany(args: unknown): Promise<Array<Omit<AnalyzeLink, 'pluggyAccountId' | 'accountId'> & { pluggyAccountId: string | null; accountId: string | null }>> };
  account: { findMany(args: unknown): Promise<Array<{ id: string; type: string }>> };
  openFinanceSavings: { findMany(args: unknown): Promise<Array<{ name: string; aliases: string[]; inPrumo: boolean; approxBalance: unknown; balanceAsOf: Date | null }>> };
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

export const ymd = (date: Date): string => date.toISOString().slice(0, 10);

function blockedText(status: string, executionStatus: string | null): string | null {
  if (executionStatus === 'USER_AUTHORIZATION_EXPIRED' || status === 'LOGIN_ERROR') {
    return 'A autorização deste banco venceu: reconecte no Meu Pluggy.';
  }
  if (status === 'WAITING_USER_INPUT') return 'O banco espera uma ação no Meu Pluggy antes de atualizar.';
  return null;
}

const isFatal = (e: unknown) => e instanceof PluggyError && (e.kind === 'auth' || e.kind === 'not_configured');

export async function analyzeOpenFinance(input: {
  householdId: string;
  db: AnalyzeDb;
  client: PluggyClient;
  from: string;
  to: string;
  ignoredSavings?: readonly string[];
  handled?: (line: BankLine) => boolean;
  takenTransactionIds?: ReadonlySet<string>;
}) {
  const { from, to } = input;
  const links = (
    await input.db.openFinanceLink.findMany({
      where: { householdId: input.householdId },
      select: { id: true, pluggyItemId: true, pluggyAccountId: true, accountId: true, importFrom: true },
      orderBy: { createdAt: 'asc' },
    })
  ).filter((l): l is AnalyzeLink & { pluggyAccountId: string; accountId: string } => !!l.pluggyAccountId && !!l.accountId);

  const savings: SavingsConfig[] = await listSavings(input.db, input.householdId);
  const ignoredSavings = [...ignoredSavingsNames(savings), ...(input.ignoredSavings ?? [])];

  const items: Array<{ itemId: string; status: string | null; blocked: string | null }> = [];
  const lines: BankLine[] = [];
  const readLinks: AnalyzeLink[] = [];
  /** Balance Pluggy gives for each account read (reais; the savings are not in it). */
  const accountBalances = new Map<string, number | null>();
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
      lines.push(...classifyAccount(transactions, { prumoAccountId: link.accountId, ignoredSavings }));
      readLinks.push(link);
      accountBalances.set(account.id, account.balance);
    }
  }

  const handled = input.handled ?? (() => false);
  const open = lines.filter((l) => !handled(l));
  const prumoAccounts = [...new Set(lines.map((l) => l.prumoAccountId))];

  let prumo: PrumoTx[] = [];
  if (prumoAccounts.length > 0) {
    const margin = MATCH_DAYS * DAY_MS;
    const rows = await input.db.transaction.findMany({
      where: {
        householdId: input.householdId,
        date: {
          gte: new Date(`${ymd(new Date(Date.parse(`${from}T00:00:00Z`) - margin))}T00:00:00Z`),
          lte: new Date(`${ymd(new Date(Date.parse(`${to}T00:00:00Z`) + margin))}T00:00:00Z`),
        },
        OR: [{ accountId: { in: prumoAccounts } }, { fromAccountId: { in: prumoAccounts } }, { toAccountId: { in: prumoAccounts } }],
      },
      select: { id: true, type: true, accountId: true, fromAccountId: true, toAccountId: true, amount: true, date: true, description: true, paid: true },
    });
    const taken = input.takenTransactionIds ?? new Set<string>();
    prumo = rows
      .filter((r) => !taken.has(r.id))
      .map((r) => ({
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
  }

  const { transfers, rest } = pairOwnTransfers(open);
  const result = matchWithPrumo({
    lines: rest.filter((l) => l.kind === 'candidate'),
    passthrough: rest.filter((l) => l.kind === 'passthrough'),
    transfers,
    prumo,
    from,
    to,
  });

  return { from, to, links, readLinks, accountBalances, items, lines, savings, result, cardsNotChecked, investmentsNotChecked };
}
