/**
 * Savings ("cofrinhos") of the bank accounts (P25 L2b1). Pluggy's daily "Rendimentos" lines do not say which savings
 * they come from, and one savings may be outside Prumo (decision of 27/11/2026). So each savings has an approximate
 * balance the user registers once (with its day); named moves ("Dinheiro reservado/retirado <name>") keep it up to
 * date, forward and backward from that day; and each day's yield is split by the balances of the day before.
 * Only the share of the savings that are Prumo money goes to the monthly yield draft.
 */
import type { BankLine } from './open-finance.classify.js';

export interface SavingsConfig {
  name: string;
  /** Other names the bank used for it (the user renamed it). */
  aliases: string[];
  /** false: money outside Prumo (payments from it are ignored, its yield is not Prumo's). */
  inPrumo: boolean;
  /** Approximate balance in cents on `asOf`; null = unknown. */
  approxCents: number | null;
  /** 'YYYY-MM-DD' */
  asOf: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const fold = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

function names(config: SavingsConfig): Set<string> {
  return new Set([config.name, ...config.aliases].map(fold));
}

function previousDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

/** Every name and alias of the savings that are not Prumo money (for the classifier). */
export function ignoredSavingsNames(savings: readonly SavingsConfig[]): string[] {
  return savings.filter((s) => !s.inPrumo).flatMap((s) => [s.name, ...s.aliases]);
}

/** Balance of a savings at the end of `date`, in cents, from its registered balance and its named moves. */
export function savingsBalanceOn(config: SavingsConfig, date: string, lines: readonly BankLine[]): number | null {
  if (config.approxCents === null || !config.asOf) return null;
  const own = names(config);
  // The savings side: "reservado <name>" takes money out of the account (-) into the savings (+), "retirado" the opposite.
  const moves = lines.filter((l) => l.kind === 'savings' && l.savingsName && own.has(fold(l.savingsName)));
  const asOf = config.asOf;
  if (date >= asOf) {
    return config.approxCents + moves.filter((m) => m.date > asOf && m.date <= date).reduce((sum, m) => sum - m.cents, 0);
  }
  return config.approxCents - moves.filter((m) => m.date > date && m.date <= asOf).reduce((sum, m) => sum - m.cents, 0);
}

/**
 * The yield lines summed per month, with Prumo's share: each day's yield split by the balances at the end of the day
 * before (rounded per day). null when some savings has no registered balance (or none is registered).
 */
export function splitYields(
  lines: readonly BankLine[],
  savings: readonly SavingsConfig[],
): Array<{ month: string; cents: number; prumoCents: number | null }> {
  const byDay = new Map<string, number>();
  for (const line of lines) {
    if (line.kind !== 'yield') continue;
    byDay.set(line.date, (byDay.get(line.date) ?? 0) + line.cents);
  }

  const months = new Map<string, { cents: number; prumoCents: number | null }>();
  for (const [day, cents] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
    const month = day.slice(0, 7);
    const entry = months.get(month) ?? { cents: 0, prumoCents: 0 };
    entry.cents += cents;

    const before = previousDay(day);
    const balances = savings.map((s) => ({ s, cents: savingsBalanceOn(s, before, lines) }));
    const total = balances.reduce((sum, b) => sum + Math.max(b.cents ?? 0, 0), 0);
    if (savings.length === 0 || balances.some((b) => b.cents === null) || total <= 0 || entry.prumoCents === null) {
      entry.prumoCents = null;
    } else {
      const ours = balances.filter((b) => b.s.inPrumo).reduce((sum, b) => sum + Math.max(b.cents!, 0), 0);
      entry.prumoCents += Math.round((cents * ours) / total);
    }
    months.set(month, entry);
  }
  return [...months].map(([month, v]) => ({ month, ...v }));
}

/**
 * Today's estimate of a savings' balance (P25 L3): the registered balance, its named moves since then, and its share
 * of each day's yield after the registered day (split by the balances of the day before, rounded per day). null when
 * this savings, or any other one sharing the yield, has no registered balance.
 */
export function estimatedSavingsBalance(
  config: SavingsConfig,
  today: string,
  lines: readonly BankLine[],
  savings: readonly SavingsConfig[],
): number | null {
  const base = savingsBalanceOn(config, today, lines);
  if (base === null || !config.asOf) return null;
  const asOf = config.asOf;

  const byDay = new Map<string, number>();
  for (const line of lines) {
    if (line.kind !== 'yield' || line.date <= asOf || line.date > today) continue;
    byDay.set(line.date, (byDay.get(line.date) ?? 0) + line.cents);
  }

  let earned = 0;
  for (const [day, cents] of byDay) {
    const before = previousDay(day);
    const balances = savings.map((s) => savingsBalanceOn(s, before, lines));
    if (balances.some((b) => b === null)) return null;
    const total = balances.reduce<number>((sum, b) => sum + Math.max(b!, 0), 0);
    const own = Math.max(savingsBalanceOn(config, before, lines)!, 0);
    if (total > 0) earned += Math.round((cents * own) / total);
  }
  return base + earned;
}

/**
 * The yield lines summed per day, with Prumo's share of each day (split by the balances at the end of the day before,
 * rounded). null when some savings has no registered balance (or none is registered). One draft per day (27/11/2026).
 */
export function splitYieldsByDay(
  lines: readonly BankLine[],
  savings: readonly SavingsConfig[],
): Array<{ date: string; cents: number; prumoCents: number | null }> {
  const byDay = new Map<string, number>();
  for (const line of lines) {
    if (line.kind !== 'yield') continue;
    byDay.set(line.date, (byDay.get(line.date) ?? 0) + line.cents);
  }
  return [...byDay]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, cents]) => {
      const before = previousDay(date);
      const balances = savings.map((s) => ({ s, cents: savingsBalanceOn(s, before, lines) }));
      const total = balances.reduce((sum, b) => sum + Math.max(b.cents ?? 0, 0), 0);
      if (savings.length === 0 || balances.some((b) => b.cents === null) || total <= 0) return { date, cents, prumoCents: null };
      const ours = balances.filter((b) => b.s.inPrumo).reduce((sum, b) => sum + Math.max(b.cents!, 0), 0);
      return { date, cents, prumoCents: Math.round((cents * ours) / total) };
    });
}
