/**
 * Open Finance preview (P25 L1): what Pluggy shows for the items linked to a household, WITHOUT writing anything.
 * For every linked item: its accounts and, for each account, the transactions of the last 30 days. The Prumo account
 * linked to a Pluggy account (if any) comes along, so the screen of links (L4) can be built on this answer.
 *
 * Only reads the links (`findMany`); importing, pairing and drafts are L2.
 */
import { PluggyError, type PluggyAccount, type PluggyClient, type PluggyTransaction } from './pluggy.client.js';

export const PREVIEW_DAYS = 30;

export interface OpenFinanceLinkRow {
  pluggyItemId: string;
  pluggyAccountId: string | null;
  accountId: string | null;
}

export interface PreviewDb {
  openFinanceLink: {
    findMany(args: {
      where: { householdId: string };
      select: { pluggyItemId: true; pluggyAccountId: true; accountId: true };
      orderBy: { createdAt: 'asc' };
    }): Promise<OpenFinanceLinkRow[]>;
  };
}

export interface PreviewAccount extends PluggyAccount {
  /** Prumo account linked to this Pluggy account, or null. */
  linkedAccountId: string | null;
  transactions: PluggyTransaction[];
}

export interface PreviewItem {
  itemId: string;
  /** Fixed text when this item could not be read (e.g. expired authorization); its accounts are then empty. */
  error: string | null;
  accounts: PreviewAccount[];
}

export interface OpenFinancePreview {
  /** 'YYYY-MM-DD', inclusive. */
  from: string;
  /** 'YYYY-MM-DD', inclusive. */
  to: string;
  items: PreviewItem[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Errors that would hit every item the same way end the whole preview. */
function isFatal(error: unknown): boolean {
  return error instanceof PluggyError && (error.kind === 'not_configured' || error.kind === 'auth');
}

export async function previewOpenFinance(input: {
  householdId: string;
  db: PreviewDb;
  client: PluggyClient;
  now?: Date;
}): Promise<OpenFinancePreview> {
  const now = input.now ?? new Date();
  const range = { from: ymd(new Date(now.getTime() - PREVIEW_DAYS * DAY_MS)), to: ymd(now) };

  const links = await input.db.openFinanceLink.findMany({
    where: { householdId: input.householdId },
    select: { pluggyItemId: true, pluggyAccountId: true, accountId: true },
    orderBy: { createdAt: 'asc' },
  });

  const linkedAccount = new Map<string, string | null>();
  for (const link of links) {
    if (link.pluggyAccountId) linkedAccount.set(link.pluggyAccountId, link.accountId);
  }
  const itemIds = [...new Set(links.map((link) => link.pluggyItemId))];

  // Items one after the other: at most 5 connections on Meu Pluggy, and no burst of requests.
  const items: PreviewItem[] = [];
  for (const itemId of itemIds) {
    try {
      const accounts: PreviewAccount[] = [];
      for (const account of await input.client.listAccounts(itemId)) {
        const transactions = await input.client.listTransactions(account.id, range);
        accounts.push({ ...account, linkedAccountId: linkedAccount.get(account.id) ?? null, transactions });
      }
      items.push({ itemId, error: null, accounts });
    } catch (error) {
      if (isFatal(error) || !(error instanceof PluggyError)) throw error;
      items.push({ itemId, error: error.message, accounts: [] });
    }
  }

  return { ...range, items };
}
