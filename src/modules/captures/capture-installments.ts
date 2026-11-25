/**
 * Installments of a purchase confirmed from a capture (P22 L2). Pure helpers: no database, no service imports, so the
 * card OFX import can use the reference format without a cycle.
 *
 * Reference format: installment 1 keeps the capture's own `notif:<dedupKey>` (so the OFX line of the purchase pairs with
 * it like with any notified purchase); installment n (n >= 2) is `notif:<dedupKey>:f<n-1>`, a future installment the
 * statement of its month adopts (the same `:f<offset>` shape the OFX import gives the futures it generates).
 * All installments share `installmentId = notif:<dedupKey>`.
 */

const CAPTURE_REF_PREFIX = 'notif:';

/** sourceRef of installment `number` (1-based) of the purchase a capture became. */
export function captureInstallmentRef(dedupKey: string, number: number): string {
  return number <= 1 ? `${CAPTURE_REF_PREFIX}${dedupKey}` : `${CAPTURE_REF_PREFIX}${dedupKey}:f${number - 1}`;
}

/** installmentId shared by all installments of one captured purchase. */
export function captureInstallmentPlanId(dedupKey: string): string {
  return `${CAPTURE_REF_PREFIX}${dedupKey}`;
}

/** True for the sourceRef of a future installment of a captured purchase (`notif:<dedupKey>:f<i>`). */
export function isCaptureFutureRef(sourceRef: string | null | undefined): boolean {
  return !!sourceRef && /^notif:[^:]+:f\d+$/.test(sourceRef);
}

/**
 * Amounts of the installments, in integer cents. Without `eachCents` the total is divided by `count` and the cents that
 * are left go to the FIRST installment (10000 in 3 -> 3334, 3333, 3333). With `eachCents` (the user corrected the
 * installment amount) every installment has that value.
 */
export function installmentAmountsCents(totalCents: number, count: number, eachCents?: number): number[] {
  if (eachCents !== undefined) return Array.from({ length: count }, () => eachCents);
  const base = Math.floor(totalCents / count);
  const rest = totalCents - base * count;
  return Array.from({ length: count }, (_, i) => (i === 0 ? base + rest : base));
}

/**
 * Dates of the installments: the first on the purchase day, installment i on the same day i months later, a day past the
 * end of that month cut to its last day (31/01 -> 28/02 -> 31/03). Every date is computed from the purchase date, never
 * from the previous installment, so the day does not drift down.
 * Source of the rule: recta-selfhosted-frontend/src/context/TransactionsContext.tsx `createInstallments`, which
 * dates installment i with date-fns `addMonths(anchor, i)` (same clamping). The form also moves the anchor one month
 * ahead when the purchase day is on or after the card's closing day; a capture keeps the purchase day, as P22 decided.
 */
export function installmentDates(first: Date, count: number): Date[] {
  const year = first.getFullYear();
  const month = first.getMonth();
  const day = first.getDate();
  return Array.from({ length: count }, (_, i) => {
    const lastDay = new Date(year, month + i + 1, 0).getDate();
    return new Date(year, month + i, Math.min(day, lastDay), 0, 0, 0, 0);
  });
}
