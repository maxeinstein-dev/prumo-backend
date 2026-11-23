import { normalizeDescription } from './detect.js';

/**
 * Which unlinked transaction is the occurrence of a monthly recurrence that some other path already entered (a confirmed
 * notification capture, the card statement OFX, the sheet, or a hand-typed row), so the job links it instead of
 * creating a second charge. Pure: the service loads the candidates (same household, account and type, unlinked, dated
 * from `adoptWindowStart(due)` to the end of the due day's month) and links the first one it can.
 *
 * Two tiers:
 *  1. Same name: the normalized description equals the recurrence name or one of its aliases. Any amount and any day of
 *     the window (the rule of the first adoption, PR #29, plus the days before the due day in the previous month).
 *  2. Similar name: one compact name (no spaces) contains the other, the shorter with at least
 *     SIMILAR_MIN_LENGTH characters; the amount within AMOUNT_TOLERANCE of an expected amount; the day from
 *     ADOPT_DAYS_BEFORE before to ADOPT_DAYS_AFTER after the due day. Never a row whose name is exactly the name of
 *     another active recurrence of the household (that charge is theirs).
 * Inside a tier: the closest day to the due day, then the closest amount, then the input order (oldest first).
 *
 * The window never goes past the end of the due day's month: a row of the next month linked here would make the next
 * month's guard believe its occurrence already exists.
 */
export const ADOPT_DAYS_BEFORE = 7;
export const ADOPT_DAYS_AFTER = 3;
export const AMOUNT_TOLERANCE = 0.1;
export const SIMILAR_MIN_LENGTH = 6;

export interface AdoptCandidate {
  id: string;
  description: string | null;
  amount: number;
  /** 'YYYY-MM-DD' */
  date: string;
}

export interface AdoptContext {
  /** Normalized names of the recurrence (recurrenceNameKeys). */
  names: ReadonlySet<string>;
  /** The amounts the occurrence could carry (full and, when there is one, discounted). */
  expectedAmounts: readonly number[];
  /** 'YYYY-MM-DD' of the occurrence. */
  dueDay: string;
  /** Normalized names of the household's OTHER active recurrences. */
  foreignNames: ReadonlySet<string>;
}

const DAY_MS = 86_400_000;
const toUtc = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const compact = (key: string) => key.replace(/\s+/g, '');

/** First day a candidate may be dated: ADOPT_DAYS_BEFORE before the due day, or the first of its month if later. */
export function adoptWindowStart(dueDay: string): string {
  const back = fromUtc(toUtc(dueDay) - ADOPT_DAYS_BEFORE * DAY_MS);
  const monthStart = `${dueDay.slice(0, 7)}-01`;
  return back < monthStart ? back : monthStart;
}

/** A normalized description resembles one of the names (compact containment, either way). */
export function similarName(key: string, names: ReadonlySet<string>): boolean {
  const a = compact(key);
  if (a.length < SIMILAR_MIN_LENGTH) return false;
  for (const name of names) {
    const b = compact(name);
    const shorter = a.length <= b.length ? a : b;
    if (shorter.length < SIMILAR_MIN_LENGTH) continue;
    if (a.includes(b) || b.includes(a)) return true;
  }
  return false;
}

/** Ids of the candidates that are the occurrence, best first (empty: none, create the occurrence). */
export function rankAdoptable(candidates: readonly AdoptCandidate[], ctx: AdoptContext): string[] {
  const due = toUtc(ctx.dueDay);
  const ranked: Array<{ id: string; tier: number; days: number; gap: number; index: number }> = [];
  candidates.forEach((c, index) => {
    const key = normalizeDescription(c.description);
    if (!key) return;
    const offset = Math.round((toUtc(c.date) - due) / DAY_MS);
    const gap = Math.min(...ctx.expectedAmounts.map((e) => Math.abs(c.amount - e)));
    if (ctx.names.has(key)) {
      ranked.push({ id: c.id, tier: 0, days: Math.abs(offset), gap, index });
      return;
    }
    if (offset < -ADOPT_DAYS_BEFORE || offset > ADOPT_DAYS_AFTER) return;
    if (ctx.foreignNames.has(key) || !similarName(key, ctx.names)) return;
    const close = ctx.expectedAmounts.some((e) => Math.abs(c.amount - e) <= Math.max(0.01, e * AMOUNT_TOLERANCE) + 1e-9);
    if (!close) return;
    ranked.push({ id: c.id, tier: 1, days: Math.abs(offset), gap, index });
  });
  ranked.sort((a, b) => a.tier - b.tier || a.days - b.days || a.gap - b.gap || a.index - b.index);
  return ranked.map((r) => r.id);
}
