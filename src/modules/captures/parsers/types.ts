import type { CaptureKind } from '../captures.schema.js';

/** P21 L6: the readings of the XP (investments). They become investment movements, never transactions. */
export const XP_KINDS = ['XP_INCOME', 'XP_REINVEST_NOTICE', 'XP_REINVEST_DONE', 'XP_STUDY'] as const;
export type XpKind = (typeof XP_KINDS)[number];

/** Why the user should look twice at a reading. POSSIBLE_OWN_TRANSFER: money that may come from another own account. */
export type CaptureWarning = 'POSSIBLE_OWN_TRANSFER';

/** What a parser understood from one notification. */
export interface ParsedCapture {
  /** `IGNORE`: a recognized notice that is not a transaction (limit, advertising); the capture is dismissed. */
  kind: CaptureKind | XpKind | 'IGNORE';
  /** null when the notification is not a transaction (notices). */
  type: 'INCOME' | 'EXPENSE' | null;
  /** Integer cents, positive; null for notices or when the (cut) text carries none. The source of `amount`. */
  amountCents: number | null;
  /** amountCents / 100 (reais): what the draft and the confirm body use. */
  amount: number | null;
  /** The draft description (merchant, "Estorno: X", or a short label). */
  description: string | null;
  /** The merchant as written, when the text names one. */
  merchant?: string;
  /** How the money moved, when the text says it. */
  method?: 'CREDIT' | 'NUPAY' | 'PIX' | 'TRANSFER';
  /** true: the capture must not become a draft (it is stored as DISMISSED, and can be restored). */
  ignore?: true;
  /** Last four digits of the card, when the text carries them. */
  cardLast4?: string;
  /** "em Nx" of the text, when present. Informative only: the draft does not create installments. */
  installments?: number;
  warning?: CaptureWarning;
  /** XP: the ticker the notification names (upper case). */
  ticker?: string;
  /** XP reinvestment notice: the day the purchase is announced for, YYYY-MM-DD. */
  executionDate?: string;
}

export interface ParserInput {
  package: string;
  title: string | null;
  text: string;
}

export type AppParser = (input: { title: string | null; text: string }) => ParsedCapture | null;
