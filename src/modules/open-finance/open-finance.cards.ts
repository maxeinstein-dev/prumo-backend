/**
 * Card check (P25, decision 3: Open Finance only checks the card; purchases and installments keep coming from the
 * invoice OFX, nothing is created here). For each Pluggy card account linked to a Prumo card:
 * - the closed bills the bank lists (GET /bills) against the Prumo invoice with the same due day: the bank total
 *   against `statementTotal` (the net purchases of the invoice window, the figure comparable with the bank);
 * - the card's balance and limit at the bank beside Prumo's, as information (Pluggy does not document what a card's
 *   balance holds).
 * Reads only.
 */
import { blockedText } from './open-finance.analyze.js';
import type { PluggyBill, PluggyClient } from './pluggy.client.js';

export const BILLS_SHOWN = 4;
const DUE_SLACK_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PrumoInvoice {
  /** 'YYYY-MM-DD' */
  dueDate: string;
  /** Reais: the net purchases of the invoice window. */
  statementTotal: number;
  state: string;
}

export interface BillLine {
  dueDate: string;
  /** Prumo invoice month ('YYYY-MM') with the same due day; null when none is near. */
  month: string | null;
  bankCents: number;
  prumoCents: number | null;
  diffCents: number | null;
  state: string | null;
}

const toCents = (reais: number | null | undefined): number | null =>
  reais === null || reais === undefined || !Number.isFinite(Number(reais)) ? null : Math.round(Number(reais) * 100);

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

const daysApart = (a: string, b: string): number => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;

export async function compareBills(bills: readonly PluggyBill[], loadInvoice: (month: string) => Promise<PrumoInvoice>): Promise<BillLine[]> {
  const recent = [...bills].sort((a, b) => b.dueDate.localeCompare(a.dueDate)).slice(0, BILLS_SHOWN);
  const lines: BillLine[] = [];
  for (const b of recent) {
    const bankCents = Math.round(b.totalAmount * 100);
    let found: { month: string; invoice: PrumoInvoice } | null = null;
    for (const month of [b.dueDate.slice(0, 7), shiftMonth(b.dueDate.slice(0, 7), -1)]) {
      const invoice = await loadInvoice(month);
      if (daysApart(invoice.dueDate, b.dueDate) <= DUE_SLACK_DAYS) {
        found = { month, invoice };
        break;
      }
    }
    if (!found) {
      lines.push({ dueDate: b.dueDate, month: null, bankCents, prumoCents: null, diffCents: null, state: null });
      continue;
    }
    const prumoCents = Math.round(found.invoice.statementTotal * 100);
    lines.push({ dueDate: b.dueDate, month: found.month, bankCents, prumoCents, diffCents: bankCents - prumoCents, state: found.invoice.state });
  }
  return lines;
}

export interface CardsDb {
  openFinanceLink: { findMany(args: unknown): Promise<Array<{ pluggyItemId: string; pluggyAccountId: string | null; accountId: string | null }>> };
  account: { findMany(args: unknown): Promise<Array<{ id: string; name: string; type: string; totalBalance: unknown; creditLimit: unknown }>> };
}

export type CardCheck =
  | { prumoAccountId: string; accountName: string; blocked: string }
  | {
      prumoAccountId: string;
      accountName: string;
      blocked: null;
      card: {
        bankBalanceCents: number | null;
        prumoBalanceCents: number | null;
        bankLimitCents: number | null;
        bankAvailableCents: number | null;
        prumoLimitCents: number | null;
        closeDate: string | null;
        dueDate: string | null;
      };
      bills: BillLine[];
    };

export async function checkCards(input: {
  householdId: string;
  db: CardsDb;
  client: PluggyClient;
  loadInvoice: (accountId: string, month: string) => Promise<PrumoInvoice>;
}): Promise<CardCheck[]> {
  const links = (
    await input.db.openFinanceLink.findMany({
      where: { householdId: input.householdId, pluggyAccountId: { not: null }, accountId: { not: null } },
      select: { pluggyItemId: true, pluggyAccountId: true, accountId: true },
      orderBy: { createdAt: 'asc' },
    })
  ).filter((l) => l.pluggyAccountId && l.accountId);
  if (links.length === 0) return [];
  const accounts = await input.db.account.findMany({
    where: { id: { in: links.map((l) => l.accountId!) }, householdId: input.householdId, type: 'CREDIT' },
    select: { id: true, name: true, type: true, totalBalance: true, creditLimit: true },
  });

  const checks: CardCheck[] = [];
  for (const link of links) {
    const account = accounts.find((a) => a.id === link.accountId && a.type === 'CREDIT');
    if (!account) continue;
    const item = await input.client.getItem(link.pluggyItemId);
    const blocked = blockedText(item.status, item.executionStatus);
    if (blocked) {
      checks.push({ prumoAccountId: account.id, accountName: account.name, blocked });
      continue;
    }
    const cards = await input.client.listCards(link.pluggyItemId);
    const card = cards.find((c) => c.id === link.pluggyAccountId);
    const bills = await compareBills(await input.client.listBills(link.pluggyAccountId!), (month) => input.loadInvoice(account.id, month));
    checks.push({
      prumoAccountId: account.id,
      accountName: account.name,
      blocked: null,
      card: {
        bankBalanceCents: toCents(card?.balance),
        prumoBalanceCents: toCents(account.totalBalance as number),
        bankLimitCents: toCents(card?.creditLimit),
        bankAvailableCents: toCents(card?.availableCreditLimit),
        prumoLimitCents: toCents(account.creditLimit as number),
        closeDate: card?.closeDate ?? null,
        dueDate: card?.dueDate ?? null,
      },
      bills,
    });
  }
  return checks;
}
