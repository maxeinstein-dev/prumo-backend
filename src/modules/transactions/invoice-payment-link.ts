import type { Prisma } from '../../generated/prisma/client.js';

/**
 * The link "this transaction pays the invoice of card X, month Y".
 *
 * It lives in two places, written together and read through this module only:
 *   - the columns `invoicePaymentAccountId` (the card) and `invoicePaymentMonth` (calendar month, `YYYY-MM`);
 *   - the legacy marker in `attachmentUrl`: `invoice_pay:<card>:<year>-<zero-based month>` (2026-9 is October 2026).
 *     The frontend builds the same text to filter invoices, so it is still written. Rows made before the columns existed
 *     carry the text only; the migration filled the columns of those whose text is strictly well formed.
 *
 * Reading prefers the columns and falls back to the text. No other production file spells the marker (see the guard).
 */

const TAG_PREFIX = 'invoice_pay:';
const CARD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// What the migration backfill accepts: a lowercase uuid and a zero-based month 0..11 without leading zero
const STRICT_TAG = /^invoice_pay:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9]{4})-([0-9]|1[01])$/;
// What the old reader accepted for the card: the text up to the next separator
const TAG_CARD = /^invoice_pay:([^:]+):/;
// What the old reader accepted for the month: a year and a month of one or two digits
const TAG_MONTH = /^(\d{4})-(\d{1,2})$/;

export interface InvoicePaymentLink {
  accountId: string;
  /** Calendar month of the invoice, `YYYY-MM`. */
  month: string;
}

/** The fields of a transaction row that carry the link; every one may be missing (a partial select, a test fixture). */
export interface InvoicePaymentFields {
  attachmentUrl?: string | null;
  invoicePaymentAccountId?: string | null;
  invoicePaymentMonth?: string | null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM` of an ordinal (year * 12 + zero-based month). */
function monthOfOrdinal(ordinal: number): string {
  return `${String(Math.floor(ordinal / 12)).padStart(4, '0')}-${pad2((ordinal % 12) + 1)}`;
}

/** Ordinal (year * 12 + zero-based month) of a calendar `YYYY-MM`. */
function ordinalOfMonth(month: string): number | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
}

/** The text marker of the payment of `accountId` for the calendar invoice month `YYYY-MM`. */
export function invoicePaymentTag(accountId: string, month: string): string {
  const ordinal = ordinalOfMonth(month);
  if (ordinal === null) throw new Error(`Invalid invoice month: ${month}`);
  return `${TAG_PREFIX}${accountId}:${Math.floor(ordinal / 12)}-${ordinal % 12}`;
}

/** Everything to store on a new payment: the legacy text and both columns. The columns are left null for an id that is not a uuid. */
export function invoicePaymentWrite(accountId: string, month: string) {
  return {
    attachmentUrl: invoicePaymentTag(accountId, month),
    invoicePaymentAccountId: CARD_UUID.test(accountId) ? accountId : null,
    invoicePaymentMonth: CARD_UUID.test(accountId) ? month : null,
  };
}

/**
 * Columns for an `attachmentUrl` that arrives from a client (create or update): filled only when the text is strictly
 * the marker (the same rule as the migration backfill), null otherwise, so the columns never outlive a changed text.
 */
export function invoicePaymentColumnsFromTag(attachmentUrl: string | null | undefined) {
  const match = attachmentUrl ? STRICT_TAG.exec(attachmentUrl) : null;
  if (!match) return { invoicePaymentAccountId: null, invoicePaymentMonth: null };
  return { invoicePaymentAccountId: match[1], invoicePaymentMonth: monthOfOrdinal(Number(match[2]) * 12 + Number(match[3])) };
}

function linkFromTag(attachmentUrl: string | null | undefined): InvoicePaymentLink | null {
  const card = attachmentUrl ? TAG_CARD.exec(attachmentUrl) : null;
  if (!card || !attachmentUrl) return null;
  const month = TAG_MONTH.exec(attachmentUrl.slice(card[0].length));
  if (!month) return null;
  return { accountId: card[1], month: monthOfOrdinal(Number(month[1]) * 12 + Number(month[2])) };
}

/** Card and invoice month a transaction pays, or null when it is not a payment or its link cannot be read. */
export function invoicePaymentLink(row: InvoicePaymentFields): InvoicePaymentLink | null {
  if (row.invoicePaymentAccountId && row.invoicePaymentMonth) {
    return { accountId: row.invoicePaymentAccountId, month: row.invoicePaymentMonth };
  }
  return linkFromTag(row.attachmentUrl);
}

/** True for any row marked as an invoice payment, even one whose month cannot be read (the old prefix check). */
export function isInvoicePayment(row: InvoicePaymentFields): boolean {
  return !!row.invoicePaymentAccountId || !!row.attachmentUrl?.startsWith(TAG_PREFIX);
}

/** The card a payment belongs to, whatever its month; null when the row is not a payment. */
export function invoicePaymentCardId(row: InvoicePaymentFields): string | null {
  if (row.invoicePaymentAccountId) return row.invoicePaymentAccountId;
  const card = row.attachmentUrl ? TAG_CARD.exec(row.attachmentUrl) : null;
  return card ? card[1] : null;
}

/** Invoice ordinal (year * 12 + zero-based month) of a payment of `cardId`; null for another card or an unreadable month. */
export function invoicePaymentOrdinal(row: InvoicePaymentFields, cardId: string): number | null {
  const link = invoicePaymentLink(row);
  if (!link || link.accountId !== cardId) return null;
  return ordinalOfMonth(link.month);
}

// ---- Prisma filters (database queries) ----

type Where = Prisma.TransactionWhereInput;

/** Text side of "payment of this card". */
export function invoiceTagOfCardWhere(cardId: string): Where {
  return { attachmentUrl: { startsWith: `${TAG_PREFIX}${cardId}:` } };
}

/** The transaction is an invoice payment (columns filled, or the text carries the marker prefix). */
export function isInvoicePaymentWhere(): Where {
  return { OR: [{ invoicePaymentAccountId: { not: null } }, { attachmentUrl: { startsWith: TAG_PREFIX } }] };
}

/** Negation of `isInvoicePaymentWhere`; spells out the null text because a comparison with NULL is never true in SQL. */
export function notInvoicePaymentWhere(): Where {
  return {
    invoicePaymentAccountId: null,
    OR: [{ attachmentUrl: null }, { NOT: { attachmentUrl: { startsWith: TAG_PREFIX } } }],
  };
}

/** The transaction pays an invoice of this card, whatever the month. */
export function invoicePaymentOfCardWhere(cardId: string): Where {
  return { OR: [{ invoicePaymentAccountId: cardId }, invoiceTagOfCardWhere(cardId)] };
}

/** The transaction pays the invoice of this card for the calendar month `YYYY-MM`. */
export function invoicePaymentOfInvoiceWhere(cardId: string, month: string): Where {
  return {
    OR: [{ invoicePaymentAccountId: cardId, invoicePaymentMonth: month }, { attachmentUrl: invoicePaymentTag(cardId, month) }],
  };
}

/**
 * The transaction carries no attachment and no payment link: the card purchases (what the invoice sums) and the rows the
 * old `attachmentUrl: null` filters meant. A row with only the columns is a payment, so the columns are checked too.
 */
export function withoutPaymentMarkerWhere(): Where {
  return { attachmentUrl: null, invoicePaymentAccountId: null };
}
