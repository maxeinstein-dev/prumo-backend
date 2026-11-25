import { BadRequestError } from '../../shared/errors/index.js';

/**
 * Pure rules of an investment position. Money is integer cents; quantity is integer micro-units (6 decimals) inside the
 * arithmetic, so nothing is summed as a float. Nothing here touches the database, a Transaction or an account balance.
 *
 * Stock exchange: quantity and weighted average price come from the movements in order (date, then creation).
 *   OPENING and BUY add quantity and cost; SELL lowers the quantity and the cost in proportion (the average price stays);
 *   INCOME changes neither.
 * Fixed income: works with value only (no quantity, no unit price). The "cost" is the amount applied: OPENING and BUY
 *   add, SELL (a redemption) lowers it, never below zero (a redemption carries the yield, which is not known here).
 */

export type MovementType = 'OPENING' | 'BUY' | 'SELL' | 'INCOME';
export type PositionKind = 'STOCK_EXCHANGE' | 'FIXED_INCOME';

export interface CalcMovement {
  id?: string;
  type: MovementType;
  /** 'YYYY-MM-DD' */
  date: string;
  createdAt: Date;
  /** Units, up to 6 decimals; null for income and for fixed income. */
  quantity: number | null;
  amountCents: number;
}

export interface PositionFigures {
  /** null for fixed income. */
  quantity: number | null;
  costCents: number;
  /** In reais per unit with 6 decimals; null without quantity. */
  avgPrice: number | null;
  incomeCents: number;
}

const MICRO = 1_000_000;
export const toMicro = (q: number): number => Math.round(q * MICRO);
const fromMicro = (m: number): number => m / MICRO;

/** What a movement does to the cash held at the broker. OPENING is a position that already existed: no cash. */
export function cashEffectCents(type: MovementType, amountCents: number): number {
  switch (type) {
    case 'BUY':
      return -amountCents;
    case 'SELL':
    case 'INCOME':
      return amountCents;
    default:
      return 0;
  }
}

export function sortMovements<T extends Pick<CalcMovement, 'date' | 'createdAt' | 'id'>>(movements: T[]): T[] {
  return [...movements].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const dt = a.createdAt.getTime() - b.createdAt.getTime();
    if (dt !== 0) return dt;
    return (a.id ?? '') < (b.id ?? '') ? -1 : (a.id ?? '') > (b.id ?? '') ? 1 : 0;
  });
}

/** round-half-up of a/b for non-negative bigints */
const divRound = (a: bigint, b: bigint): bigint => (a * 2n + b) / (b * 2n);

export function computePosition(kind: PositionKind, movements: CalcMovement[]): PositionFigures {
  let qtyMicro = 0;
  let cost = 0;
  let income = 0;

  for (const m of sortMovements(movements)) {
    if (m.type === 'INCOME') {
      income += m.amountCents;
      continue;
    }
    if (kind === 'FIXED_INCOME') {
      if (m.type === 'SELL') cost = Math.max(0, cost - m.amountCents);
      else cost += m.amountCents;
      continue;
    }
    const q = toMicro(m.quantity ?? 0);
    if (m.type === 'SELL') {
      if (q > qtyMicro) {
        throw new BadRequestError(
          `Cannot sell more than the position holds on ${m.date} (holds ${fromMicro(qtyMicro)}, selling ${fromMicro(q)})`,
        );
      }
      const left = qtyMicro - q;
      cost = left === 0 ? 0 : Number(divRound(BigInt(cost) * BigInt(left), BigInt(qtyMicro)));
      qtyMicro = left;
    } else {
      qtyMicro += q;
      cost += m.amountCents;
    }
  }

  if (kind === 'FIXED_INCOME') return { quantity: null, costCents: cost, avgPrice: null, incomeCents: income };
  const avgPrice = qtyMicro > 0 ? Number(divRound(BigInt(cost) * 10_000_000_000n, BigInt(qtyMicro))) / MICRO : null;
  return { quantity: fromMicro(qtyMicro), costCents: cost, avgPrice, incomeCents: income };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Same month and day one year before; 29 Feb falls on 28 Feb. */
function oneYearBefore(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const dd = m === 2 && d === 29 ? 28 : d;
  return `${y - 1}-${pad(m)}-${pad(dd)}`;
}

/** Income received in the 12 months ending `today` (exclusive of the same day a year ago). */
export function incomeLast12MonthsCents(movements: Pick<CalcMovement, 'type' | 'date' | 'amountCents'>[], today: string): number {
  const since = oneYearBefore(today);
  return movements
    .filter((m) => m.type === 'INCOME' && m.date > since && m.date <= today)
    .reduce((sum, m) => sum + m.amountCents, 0);
}

/**
 * Money of a stock movement. The total (integer cents) is what moved; when it is missing it is quantity x unit price
 * rounded to the cent. A missing unit price is total / quantity at six decimals. When both come, the total wins.
 */
export function deriveAmounts(input: { quantity: number; unitPrice?: number; amountCents?: number }): {
  amountCents: number;
  unitPrice: number;
} {
  const qMicro = BigInt(toMicro(input.quantity));
  if (input.amountCents !== undefined) {
    const unitPrice = input.unitPrice ?? Number(divRound(BigInt(input.amountCents) * 10_000_000_000n, qMicro)) / MICRO;
    return { amountCents: input.amountCents, unitPrice };
  }
  if (input.unitPrice === undefined) throw new BadRequestError('Inform the amount or the unit price');
  const priceMicro = BigInt(Math.round(input.unitPrice * MICRO));
  return { amountCents: Number(divRound(qMicro * priceMicro, 10_000_000_000n)), unitPrice: input.unitPrice };
}
