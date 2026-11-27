/**
 * The household's savings ("cofrinhos") register (P25 L2b1): list it as the classifier's config, and replace it as a
 * whole (like the links). Names and aliases are unique in the household, ignoring accents and case.
 */
import { BadRequestError } from '../../shared/errors/app-error.js';
import type { SavingsConfig } from './open-finance.savings.js';

interface SavingsRow {
  name: string;
  aliases: string[];
  inPrumo: boolean;
  approxBalance: unknown;
  balanceAsOf: Date | null;
}

export interface SavingsDb {
  openFinanceSavings: {
    findMany(args: unknown): Promise<SavingsRow[]>;
    deleteMany(args: unknown): Promise<unknown>;
    createMany(args: { data: Array<Record<string, unknown>> }): Promise<unknown>;
  };
  $transaction<T>(fn: (tx: SavingsDb) => Promise<T>): Promise<T>;
}

export interface SavingsInput {
  name: string;
  aliases?: string[];
  inPrumo: boolean;
  /** Reais, approximately; with balanceAsOf, or both null. */
  approxBalance?: number | null;
  /** 'YYYY-MM-DD' */
  balanceAsOf?: string | null;
}

const fold = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

export async function listSavings(db: { openFinanceSavings: Pick<SavingsDb['openFinanceSavings'], 'findMany'> }, householdId: string): Promise<SavingsConfig[]> {
  const rows = await db.openFinanceSavings.findMany({
    where: { householdId },
    orderBy: { name: 'asc' },
    select: { name: true, aliases: true, inPrumo: true, approxBalance: true, balanceAsOf: true },
  });
  return rows.map((row) => ({
    name: row.name,
    aliases: row.aliases,
    inPrumo: row.inPrumo,
    approxCents: row.approxBalance === null || row.approxBalance === undefined ? null : Math.round(Number(row.approxBalance) * 100),
    asOf: row.balanceAsOf ? row.balanceAsOf.toISOString().slice(0, 10) : null,
  }));
}

export async function replaceSavings(db: SavingsDb, householdId: string, input: readonly SavingsInput[]): Promise<void> {
  const clean = input.map((s) => ({
    name: s.name.trim(),
    aliases: [...new Set((s.aliases ?? []).map((a) => a.trim()).filter(Boolean))],
    inPrumo: s.inPrumo,
    approxBalance: s.approxBalance ?? null,
    balanceAsOf: s.balanceAsOf ?? null,
  }));

  const seen = new Set<string>();
  for (const s of clean) {
    for (const name of [s.name, ...s.aliases]) {
      const key = fold(name);
      if (seen.has(key)) throw new BadRequestError(`The savings name "${name}" appears twice`);
      seen.add(key);
    }
  }

  await db.$transaction(async (tx) => {
    await tx.openFinanceSavings.deleteMany({ where: { householdId } });
    if (clean.length > 0) {
      await tx.openFinanceSavings.createMany({
        data: clean.map((s) => ({
          householdId,
          name: s.name,
          aliases: s.aliases,
          inPrumo: s.inPrumo,
          approxBalance: s.approxBalance,
          balanceAsOf: s.balanceAsOf ? new Date(`${s.balanceAsOf}T00:00:00Z`) : null,
        })),
      });
    }
  });
}
