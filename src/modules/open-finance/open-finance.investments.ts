/**
 * Investments check (P25 L5, decision 4: only a warning, never overwriting positions or quotes). The broker's portfolio
 * as Pluggy shows it against what P21 computes for the linked investment account:
 * - exchange-traded assets (stocks, real-estate funds, ETFs, BDRs) match by ticker: same quantity, a different one
 *   (a buy or sale missing in Prumo), only at the bank, only in Prumo;
 * - fixed income, funds and the rest compare as one total (their names do not match one to one);
 * - cash (the broker account's balance) and the account total (positions + cash) on both sides.
 */
import { blockedText } from './open-finance.analyze.js';
import type { PluggyClient, PluggyInvestment } from './pluggy.client.js';

const EXCHANGE_SUBTYPES = new Set(['STOCK', 'REAL_ESTATE_FUND', 'BDR', 'ETF']);

export interface PrumoPortfolio {
  summary: { cashBalance: number; totalValue: number };
  positions: Array<{ kind: string; ticker: string | null; name: string; quantity: number; currentValue: number; closedAt: string | null }>;
}

export interface StockLine {
  ticker: string;
  bankQuantity: number | null;
  prumoQuantity: number | null;
  bankCents: number | null;
  prumoCents: number | null;
  status: 'same' | 'quantity' | 'bank_only' | 'prumo_only';
}

const toCents = (reais: number): number => Math.round(reais * 100);
const tickerOf = (code: string | null): string | null => (code ? code.trim().toUpperCase() || null : null);

function isExchange(inv: PluggyInvestment): boolean {
  return !!tickerOf(inv.code) && (inv.type === 'EQUITY' || inv.type === 'ETF' || EXCHANGE_SUBTYPES.has(inv.subtype ?? ''));
}

export function compareInvestments(input: { bank: readonly PluggyInvestment[]; bankCashCents: number; prumo: PrumoPortfolio }) {
  const bank = input.bank.filter((inv) => inv.status !== 'TOTAL_WITHDRAWAL');
  const bankStocks = new Map<string, { quantity: number; cents: number }>();
  let bankOthers = 0;
  for (const inv of bank) {
    if (isExchange(inv)) {
      const ticker = tickerOf(inv.code)!;
      const prev = bankStocks.get(ticker) ?? { quantity: 0, cents: 0 };
      bankStocks.set(ticker, { quantity: prev.quantity + (inv.quantity ?? 0), cents: prev.cents + toCents(inv.balance) });
    } else {
      bankOthers += toCents(inv.balance);
    }
  }

  const open = input.prumo.positions.filter((p) => p.closedAt === null);
  const prumoStocks = new Map<string, { quantity: number; cents: number }>();
  let prumoOthers = 0;
  for (const p of open) {
    const ticker = p.kind === 'STOCK_EXCHANGE' ? tickerOf(p.ticker) : null;
    if (ticker) {
      const prev = prumoStocks.get(ticker) ?? { quantity: 0, cents: 0 };
      prumoStocks.set(ticker, { quantity: prev.quantity + p.quantity, cents: prev.cents + toCents(p.currentValue) });
    } else {
      prumoOthers += toCents(p.currentValue);
    }
  }

  const tickers = [...new Set([...bankStocks.keys(), ...prumoStocks.keys()])].sort();
  const stocks: StockLine[] = tickers.map((ticker) => {
    const b = bankStocks.get(ticker);
    const p = prumoStocks.get(ticker);
    const status: StockLine['status'] = !p ? 'bank_only' : !b ? 'prumo_only' : Math.abs(b.quantity - p.quantity) < 1e-6 ? 'same' : 'quantity';
    return { ticker, bankQuantity: b?.quantity ?? null, prumoQuantity: p?.quantity ?? null, bankCents: b?.cents ?? null, prumoCents: p?.cents ?? null, status };
  });

  const bankStocksCents = [...bankStocks.values()].reduce((s, v) => s + v.cents, 0);
  const bankTotal = bankStocksCents + bankOthers + input.bankCashCents;
  const prumoTotal = toCents(input.prumo.summary.totalValue);
  return {
    stocks,
    others: { bankCents: bankOthers, prumoCents: prumoOthers },
    cash: { bankCents: input.bankCashCents, prumoCents: toCents(input.prumo.summary.cashBalance) },
    total: { bankCents: bankTotal, prumoCents: prumoTotal, diffCents: bankTotal - prumoTotal },
  };
}

export interface InvestmentsDb {
  openFinanceLink: { findMany(args: unknown): Promise<Array<{ pluggyItemId: string; pluggyAccountId: string | null; accountId: string | null }>> };
  account: { findMany(args: unknown): Promise<Array<{ id: string; name: string; type: string }>> };
}

export type InvestmentsCheck =
  | { prumoAccountId: string; accountName: string; blocked: string }
  | ({ prumoAccountId: string; accountName: string; blocked: null; itemId: string } & ReturnType<typeof compareInvestments>);

/** Every link to an investment account of Prumo: the broker portfolio and cash from Pluggy against P21. Reads only. */
export async function checkInvestments(input: {
  householdId: string;
  db: InvestmentsDb;
  client: PluggyClient;
  loadPortfolio: (accountId: string) => Promise<PrumoPortfolio>;
}): Promise<InvestmentsCheck[]> {
  const links = (
    await input.db.openFinanceLink.findMany({
      where: { householdId: input.householdId, pluggyAccountId: { not: null }, accountId: { not: null } },
      select: { pluggyItemId: true, pluggyAccountId: true, accountId: true },
      orderBy: { createdAt: 'asc' },
    })
  ).filter((l) => l.pluggyAccountId && l.accountId);
  if (links.length === 0) return [];
  const accounts = await input.db.account.findMany({
    where: { id: { in: links.map((l) => l.accountId!) }, householdId: input.householdId, type: 'INVESTMENT' },
    select: { id: true, name: true, type: true },
  });

  const checks: InvestmentsCheck[] = [];
  for (const link of links) {
    const account = accounts.find((a) => a.id === link.accountId && a.type === 'INVESTMENT');
    if (!account) continue;
    const item = await input.client.getItem(link.pluggyItemId);
    const blocked = blockedText(item.status, item.executionStatus);
    if (blocked) {
      checks.push({ prumoAccountId: account.id, accountName: account.name, blocked });
      continue;
    }
    const [bank, pluggyAccounts, prumo] = await Promise.all([
      input.client.listInvestments(link.pluggyItemId),
      input.client.listAccounts(link.pluggyItemId),
      input.loadPortfolio(account.id),
    ]);
    const cash = pluggyAccounts.find((a) => a.id === link.pluggyAccountId)?.balance ?? 0;
    checks.push({
      prumoAccountId: account.id,
      accountName: account.name,
      blocked: null,
      itemId: link.pluggyItemId,
      ...compareInvestments({ bank, bankCashCents: Math.round((cash ?? 0) * 100), prumo }),
    });
  }
  return checks;
}
