/**
 * Default split of a recurrence (P19): the shares each occurrence is born with. Pure arithmetic on integer cents, the
 * same rounding as the `percent` strategy of people/split-strategies.ts (each part rounded down; when the percents add
 * up to 100 the first person takes the cents left, so nothing is left to me).
 */

/** Largest number of people in a default split (a safety cap far above any real bill). */
export const MAX_DEFAULT_SHARES = 20;

export interface DefaultShareRule {
  personId: string;
  /** Percent of the real occurrence amount (2 decimals, > 0, <= 100), or null when `amount` is set. */
  percent: number | null;
  /** Fixed reais, or null when `percent` is set. */
  amount: number | null;
}

export interface DefaultShareInput {
  personId: string;
  percent?: number | null;
  amount?: number | null;
}

export interface DefaultSplitPart {
  personId: string;
  amountCents: number;
}

const isSet = (value: number | null | undefined): value is number => value !== null && value !== undefined;

/** Basis points (1/100 of a percent) of a stored percent; 100% = 10000. */
function basisPoints(percent: number): number {
  return Math.round(percent * 100);
}

/**
 * The part of each ACTIVE person for an occurrence of `totalCents`. People no longer active (or gone) are skipped:
 * their part stays with me. A fixed amount is capped by what is left of the occurrence (the bill came lower than the
 * fixed value). Parts of zero cents are dropped. Never throws: generating the occurrence must not fail on the split.
 */
export function defaultSplitParts(totalCents: number, rules: readonly DefaultShareRule[], activePersonIds: ReadonlySet<string>): DefaultSplitPart[] {
  if (!Number.isInteger(totalCents) || totalCents <= 0) return [];
  const usable = rules.filter((rule) => activePersonIds.has(rule.personId));
  if (usable.length === 0) return [];

  let amounts: number[];
  if (usable.every((rule) => isSet(rule.percent))) {
    const points = usable.map((rule) => basisPoints(rule.percent!));
    const sum = points.reduce((a, b) => a + b, 0);
    if (sum > 10000) return [];
    amounts = points.map((bp) => Math.floor((totalCents * bp) / 10000));
    if (sum === 10000) amounts[0]! += totalCents - amounts.reduce((a, b) => a + b, 0);
  } else if (usable.every((rule) => isSet(rule.amount))) {
    let left = totalCents;
    amounts = usable.map((rule) => {
      const part = Math.min(Math.round(rule.amount! * 100), left);
      left -= part;
      return part;
    });
  } else {
    return []; // a mixed rule cannot be stored (validated on input); never guess
  }

  return usable
    .map((rule, i) => ({ personId: rule.personId, amountCents: amounts[i]! }))
    .filter((part) => part.amountCents > 0);
}

/**
 * Problem with a default split typed by the user, or null when it is fine. One kind per recurrence (every entry a
 * percent, or every entry an amount), each entry exactly one of the two, nobody twice, percents with 2 decimals adding
 * up to at most 100, amounts positive with 2 decimals.
 */
export function validateDefaultShares(entries: readonly DefaultShareInput[]): string | null {
  if (entries.length > MAX_DEFAULT_SHARES) return `A default split takes at most ${MAX_DEFAULT_SHARES} people`;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.personId)) return 'A person appears more than once in the default split';
    seen.add(entry.personId);
    if (isSet(entry.percent) === isSet(entry.amount)) return 'Each person of the default split takes a percent or an amount (one of the two)';
    if (isSet(entry.percent)) {
      const p = entry.percent;
      if (!Number.isFinite(p) || p <= 0 || p > 100) return 'The percent must be greater than 0 and at most 100';
      if (Math.abs(p * 100 - Math.round(p * 100)) > 1e-6) return 'The percent must have at most 2 decimal places';
    } else {
      const a = entry.amount!;
      if (!Number.isFinite(a) || a <= 0 || a > 1_000_000_000) return 'The amount must be greater than 0';
      if (Math.abs(a * 100 - Math.round(a * 100)) > 1e-6) return 'The amount must have at most 2 decimal places';
    }
  }
  const percents = entries.filter((e) => isSet(e.percent));
  if (percents.length > 0 && percents.length !== entries.length) return 'Every person of the default split must use the same kind (all percent or all amount)';
  if (percents.reduce((sum, e) => sum + basisPoints(e.percent!), 0) > 10000) return 'The percents add up to more than 100%';
  return null;
}
