/**
 * Balance check (P25 L3): the bank balance saved by the last Open Finance import of each linked account against the
 * current balance of the Prumo account. Reads only the database (no Pluggy call), so the Início can ask it freely.
 *
 * Tolerance (decision of 27/11/2026): an exact bank balance warns from 1 cent of difference; one with an estimated part
 * (the savings of a wallet) only above R$ 1,00. The cards are left for a later lot.
 */
export const EXACT_TOLERANCE_CENTS = 0;
export const ESTIMATED_TOLERANCE_CENTS = 100;

export interface BalancesDb {
  openFinanceLink: {
    findMany(args: unknown): Promise<
      Array<{ accountId: string | null; bankBalance: unknown; bankBalanceAt: Date | null; bankBalanceEstimated: boolean }>
    >;
  };
  account: { findMany(args: unknown): Promise<Array<{ id: string; name: string; totalBalance: unknown }>> };
}

export interface BalanceCheck {
  prumoAccountId: string;
  accountName: string;
  bankCents: number;
  prumoCents: number;
  /** bank - Prumo: positive = the bank has more than Prumo says. */
  diffCents: number;
  estimated: boolean;
  toleranceCents: number;
  alert: boolean;
  /** When the bank balance was read (ISO). */
  at: string | null;
}

const toCents = (value: unknown): number => Math.round(Number(value) * 100);

export async function balanceChecks(input: { db: BalancesDb; householdId: string }): Promise<BalanceCheck[]> {
  const links = (
    await input.db.openFinanceLink.findMany({
      where: { householdId: input.householdId, accountId: { not: null }, bankBalance: { not: null } },
      select: { accountId: true, bankBalance: true, bankBalanceAt: true, bankBalanceEstimated: true },
      orderBy: { createdAt: 'asc' },
    })
  ).filter((l) => l.accountId && l.bankBalance !== null && l.bankBalance !== undefined);
  if (links.length === 0) return [];

  const accounts = await input.db.account.findMany({
    where: { id: { in: links.map((l) => l.accountId!) }, householdId: input.householdId, isActive: true },
    select: { id: true, name: true, totalBalance: true },
  });

  return links.flatMap((link) => {
    const account = accounts.find((a) => a.id === link.accountId);
    if (!account) return [];
    const bankCents = toCents(link.bankBalance);
    const prumoCents = toCents(account.totalBalance);
    const diffCents = bankCents - prumoCents;
    const toleranceCents = link.bankBalanceEstimated ? ESTIMATED_TOLERANCE_CENTS : EXACT_TOLERANCE_CENTS;
    return [
      {
        prumoAccountId: account.id,
        accountName: account.name,
        bankCents,
        prumoCents,
        diffCents,
        estimated: link.bankBalanceEstimated,
        toleranceCents,
        alert: Math.abs(diffCents) > toleranceCents,
        at: link.bankBalanceAt ? link.bankBalanceAt.toISOString() : null,
      },
    ];
  });
}
