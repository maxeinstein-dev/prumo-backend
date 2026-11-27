/**
 * Links of Open Finance (P25 L4): which Pluggy items the household reads and which Prumo account each Pluggy account
 * feeds. A row with pluggyAccountId null registers an item (its id is copied by hand from the Meu Pluggy dashboard);
 * a row with pluggyAccountId links that Pluggy account to a Prumo account. A Pluggy account without a row is ignored.
 *
 * - listLinks reads the Pluggy accounts of each item (no transactions) and pairs them with the saved links. A saved link
 *   whose Pluggy account is not listed comes back as "orphan" (e.g. after a renewed authorization changed the ids).
 * - replaceAccountLinks replaces every account link of the household at once, in one transaction (like PUT
 *   /captures/account-rules); the item rows stay.
 * - addItem / replaceItem / removeItem manage the items; replaceItem keeps the account links (Pluggy may change the item
 *   id when the user renews the authorization).
 */
import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { PluggyError, type PluggyAccount, type PluggyClient } from './pluggy.client.js';

interface LinkRow {
  pluggyItemId: string;
  pluggyAccountId: string | null;
  accountId: string | null;
}

interface LinkTable {
  findMany(args: { where: Record<string, unknown>; orderBy?: unknown; select?: unknown }): Promise<LinkRow[]>;
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  createMany(args: { data: Array<Record<string, unknown>> }): Promise<unknown>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
}

export interface LinksDb {
  openFinanceLink: LinkTable;
  account: {
    findMany(args: { where: { id: { in: string[] }; householdId: string; isActive: true }; select: { id: true } }): Promise<Array<{ id: string }>>;
  };
  $transaction<T>(fn: (tx: LinksDb) => Promise<T>): Promise<T>;
}

export interface LinkedAccount extends PluggyAccount {
  /** Prumo account fed by this Pluggy account, or null (ignored). */
  accountId: string | null;
}

export interface LinksItem {
  itemId: string;
  /** Fixed text when Pluggy could not read this item; its accounts are then empty. */
  error: string | null;
  accounts: LinkedAccount[];
  /** Saved links whose Pluggy account was not listed (renewed item, closed account, or the item could not be read). */
  orphanLinks: Array<{ pluggyAccountId: string; accountId: string | null }>;
}

export interface AccountLinkInput {
  pluggyItemId: string;
  pluggyAccountId: string;
  accountId: string;
}

async function householdRows(db: LinksDb, householdId: string): Promise<LinkRow[]> {
  return db.openFinanceLink.findMany({
    where: { householdId },
    orderBy: { createdAt: 'asc' },
    select: { pluggyItemId: true, pluggyAccountId: true, accountId: true },
  });
}

export async function listLinks(input: { householdId: string; db: LinksDb; client: PluggyClient }): Promise<{ items: LinksItem[] }> {
  const rows = await householdRows(input.db, input.householdId);
  const itemIds = [...new Set(rows.map((row) => row.pluggyItemId))];

  const items: LinksItem[] = [];
  for (const itemId of itemIds) {
    const saved = rows.filter((row) => row.pluggyItemId === itemId && row.pluggyAccountId);
    let accounts: PluggyAccount[] = [];
    let error: string | null = null;
    try {
      accounts = await input.client.listAccounts(itemId);
    } catch (e) {
      if (!(e instanceof PluggyError) || e.kind === 'auth' || e.kind === 'not_configured') throw e;
      error = e.message;
    }
    const listed = new Set(accounts.map((account) => account.id));
    items.push({
      itemId,
      error,
      accounts: accounts.map((account) => ({
        ...account,
        accountId: saved.find((row) => row.pluggyAccountId === account.id)?.accountId ?? null,
      })),
      orphanLinks: saved
        .filter((row) => !listed.has(row.pluggyAccountId!))
        .map((row) => ({ pluggyAccountId: row.pluggyAccountId!, accountId: row.accountId })),
    });
  }
  return { items };
}

export async function replaceAccountLinks(input: { householdId: string; db: LinksDb; links: AccountLinkInput[] }): Promise<void> {
  const { householdId, db, links } = input;

  const pluggyIds = links.map((link) => link.pluggyAccountId);
  if (new Set(pluggyIds).size !== pluggyIds.length) throw new BadRequestError('The same Pluggy account appears twice');
  const accountIds = links.map((link) => link.accountId);
  if (new Set(accountIds).size !== accountIds.length) {
    throw new BadRequestError('Two Pluggy accounts cannot feed the same Prumo account');
  }

  await db.$transaction(async (tx) => {
    const items = new Set((await householdRows(tx, householdId)).map((row) => row.pluggyItemId));
    if (links.some((link) => !items.has(link.pluggyItemId))) throw new NotFoundError('Open Finance item');
    if (accountIds.length > 0) {
      const found = await tx.account.findMany({ where: { id: { in: accountIds }, householdId, isActive: true }, select: { id: true } });
      if (found.length !== accountIds.length) throw new NotFoundError('Account');
    }
    await tx.openFinanceLink.deleteMany({ where: { householdId, pluggyAccountId: { not: null } } });
    if (links.length > 0) {
      await tx.openFinanceLink.createMany({
        data: links.map((link) => ({ householdId, pluggyItemId: link.pluggyItemId, pluggyAccountId: link.pluggyAccountId, accountId: link.accountId })),
      });
    }
  });
}

export async function addItem(input: { householdId: string; db: LinksDb; itemId: string }): Promise<void> {
  const { householdId, db, itemId } = input;
  const existing = await db.openFinanceLink.findMany({ where: { householdId, pluggyItemId: itemId } });
  if (existing.length > 0) throw new ConflictError('This Open Finance item is already registered');
  await db.openFinanceLink.create({ data: { householdId, pluggyItemId: itemId } });
}

export async function replaceItem(input: { householdId: string; db: LinksDb; itemId: string; newItemId: string }): Promise<void> {
  const { householdId, db, itemId, newItemId } = input;
  await db.$transaction(async (tx) => {
    const current = await tx.openFinanceLink.findMany({ where: { householdId, pluggyItemId: itemId } });
    if (current.length === 0) throw new NotFoundError('Open Finance item');
    const taken = await tx.openFinanceLink.findMany({ where: { householdId, pluggyItemId: newItemId } });
    if (taken.length > 0) throw new ConflictError('The new item id is already registered');
    await tx.openFinanceLink.updateMany({ where: { householdId, pluggyItemId: itemId }, data: { pluggyItemId: newItemId } });
  });
}

export async function removeItem(input: { householdId: string; db: LinksDb; itemId: string }): Promise<void> {
  const { count } = await input.db.openFinanceLink.deleteMany({ where: { householdId: input.householdId, pluggyItemId: input.itemId } });
  if (count === 0) throw new NotFoundError('Open Finance item');
}
