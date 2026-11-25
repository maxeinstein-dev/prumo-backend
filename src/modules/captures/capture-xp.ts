import { XP_KINDS, type XpKind } from './parsers/types.js';

/** The package of the XP app: the only one whose readings become investment movements (P21 L6). */
export const XP_PACKAGE = 'br.com.xp.carteira';

/** Decision 3 of P21: a notification no reader understands is kept this long and then deleted. */
export const STUDY_RETENTION_DAYS = 60;
const DAY_MS = 86_400_000;

export function isXpKind(kind: unknown): kind is XpKind {
  return typeof kind === 'string' && (XP_KINDS as readonly string[]).includes(kind);
}

/** Which movement a draft of this kind becomes; null for a kind that makes no draft (the notice, the study text). */
export function isInvestmentDraftKind(kind: unknown): 'INCOME' | 'BUY' | null {
  if (kind === 'XP_INCOME') return 'INCOME';
  if (kind === 'XP_REINVEST_DONE') return 'BUY';
  return null;
}

/** Same reference rule as a transaction made from a capture; unique per household in investment_movements. */
export function investmentSourceRef(dedupKey: string): string {
  return `notif:${dedupKey}`;
}

/**
 * Decision 4 of P21: executed amount / quote of the day, nearest integer (half up), at least 1. null without a usable
 * quote: the screen then leaves the field empty. Only a suggestion; the user confirms or corrects.
 */
export function suggestedQuantity(amountCents: number, price: number | null): number | null {
  if (price === null || !Number.isFinite(price) || !(price > 0)) return null;
  return Math.max(1, Math.round(amountCents / 100 / price));
}

const SAO_PAULO_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });

/** YYYY-MM-DD of an instant on the clock of Brasilia (the day the user saw the notification). */
export function saoPauloDay(at: Date): string {
  return SAO_PAULO_DAY.format(at);
}

/** Study captures created before this instant are deleted. */
export function studyCutoff(now: Date): Date {
  return new Date(now.getTime() - STUDY_RETENTION_DAYS * DAY_MS);
}

export function studyExpiry(createdAt: Date): Date {
  return new Date(createdAt.getTime() + STUDY_RETENTION_DAYS * DAY_MS);
}
