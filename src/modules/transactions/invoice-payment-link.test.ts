import { describe, expect, it } from 'vitest';
import {
  invoicePaymentCardId,
  invoicePaymentColumnsFromTag,
  invoicePaymentLink,
  invoicePaymentOfCardWhere,
  invoicePaymentOfInvoiceWhere,
  invoicePaymentOrdinal,
  invoicePaymentTag,
  invoicePaymentWrite,
  invoiceTagOfCardWhere,
  isInvoicePayment,
  isInvoicePaymentWhere,
  notInvoicePaymentWhere,
  withoutPaymentMarkerWhere,
} from './invoice-payment-link.js';

const CARD = '22222222-2222-2222-2222-222222222222';
const OTHER = '33333333-3333-3333-3333-333333333333';

// The three shapes a payment row can have: (a) legacy, text only; (b) new, columns and text; (c) columns only
const legacy = { attachmentUrl: `invoice_pay:${CARD}:2026-9`, invoicePaymentAccountId: null, invoicePaymentMonth: null };
const both = { attachmentUrl: `invoice_pay:${CARD}:2026-9`, invoicePaymentAccountId: CARD, invoicePaymentMonth: '2026-10' };
const columnsOnly = { attachmentUrl: null, invoicePaymentAccountId: CARD, invoicePaymentMonth: '2026-10' };
const SHAPES = { legacy, both, columnsOnly };

describe('invoicePaymentLink', () => {
  it.each(Object.entries(SHAPES))('reads the same card and calendar month from the %s shape', (_name, row) => {
    expect(invoicePaymentLink(row)).toEqual({ accountId: CARD, month: '2026-10' });
  });

  it('turns the zero-based month of the text into the calendar month, across the year', () => {
    expect(invoicePaymentLink({ attachmentUrl: `invoice_pay:${CARD}:2026-0` })).toEqual({ accountId: CARD, month: '2026-01' });
    expect(invoicePaymentLink({ attachmentUrl: `invoice_pay:${CARD}:2026-11` })).toEqual({ accountId: CARD, month: '2026-12' });
  });

  it('keeps reading what the old parser accepted: a padded month, and a month past 11 rolls by ordinal', () => {
    expect(invoicePaymentLink({ attachmentUrl: `invoice_pay:${CARD}:2026-09` })).toEqual({ accountId: CARD, month: '2026-10' });
    expect(invoicePaymentLink({ attachmentUrl: `invoice_pay:${CARD}:2026-12` })).toEqual({ accountId: CARD, month: '2027-01' });
  });

  it('prefers the columns when they disagree with the text', () => {
    const row = { attachmentUrl: `invoice_pay:${OTHER}:2026-0`, invoicePaymentAccountId: CARD, invoicePaymentMonth: '2026-10' };
    expect(invoicePaymentLink(row)).toEqual({ accountId: CARD, month: '2026-10' });
  });

  it('falls back to the text when only one column is filled', () => {
    expect(invoicePaymentLink({ ...legacy, invoicePaymentAccountId: CARD })).toEqual({ accountId: CARD, month: '2026-10' });
    expect(invoicePaymentLink({ ...legacy, invoicePaymentMonth: '2026-10' })).toEqual({ accountId: CARD, month: '2026-10' });
  });

  it('is null for a row that is not a readable payment', () => {
    for (const attachmentUrl of [
      null,
      undefined,
      'https://example.com/receipt.pdf',
      'invoice_pay:abc',
      `invoice_pay:${CARD}:garbage`,
      `invoice_pay:${CARD}:2026-9 `,
      'invoice_pay::2026-9',
      `x invoice_pay:${CARD}:2026-9`,
      `INVOICE_PAY:${CARD}:2026-9`,
    ]) {
      expect(invoicePaymentLink({ attachmentUrl }), String(attachmentUrl)).toBeNull();
    }
  });
});

describe('isInvoicePayment', () => {
  it.each(Object.entries(SHAPES))('is true for the %s shape', (_name, row) => {
    expect(isInvoicePayment(row)).toBe(true);
  });

  it('counts every row tagged with the prefix, readable or not (the old startsWith check)', () => {
    expect(isInvoicePayment({ attachmentUrl: 'invoice_pay:abc' })).toBe(true);
    expect(isInvoicePayment({ attachmentUrl: `invoice_pay:${CARD}:garbage` })).toBe(true);
  });

  it('is false for a purchase, an attachment URL and a row without either marker', () => {
    expect(isInvoicePayment({ attachmentUrl: null })).toBe(false);
    expect(isInvoicePayment({})).toBe(false);
    expect(isInvoicePayment({ attachmentUrl: 'https://example.com/a.pdf', invoicePaymentAccountId: null })).toBe(false);
    expect(isInvoicePayment({ attachmentUrl: `x invoice_pay:${CARD}:2026-9` })).toBe(false);
  });
});

describe('invoicePaymentCardId and invoicePaymentOrdinal', () => {
  it.each(Object.entries(SHAPES))('give the card and the invoice ordinal of the %s shape', (_name, row) => {
    expect(invoicePaymentCardId(row)).toBe(CARD);
    expect(invoicePaymentOrdinal(row, CARD)).toBe(2026 * 12 + 9);
    expect(invoicePaymentOrdinal(row, OTHER)).toBeNull();
  });

  it('reads the card of an unreadable month (the card filters never looked at the month)', () => {
    expect(invoicePaymentCardId({ attachmentUrl: `invoice_pay:${CARD}:garbage` })).toBe(CARD);
    expect(invoicePaymentOrdinal({ attachmentUrl: `invoice_pay:${CARD}:garbage` }, CARD)).toBeNull();
  });

  it('has no card when the text has no second separator or the row is not a payment', () => {
    expect(invoicePaymentCardId({ attachmentUrl: 'invoice_pay:abc' })).toBeNull();
    expect(invoicePaymentCardId({ attachmentUrl: null })).toBeNull();
    expect(invoicePaymentCardId({ attachmentUrl: 'https://example.com/a.pdf' })).toBeNull();
  });

  it('keeps the ordinals of the old parser', () => {
    expect(invoicePaymentOrdinal({ attachmentUrl: 'invoice_pay:card-1:2026-9' }, 'card-1')).toBe(2026 * 12 + 9);
    expect(invoicePaymentOrdinal({ attachmentUrl: 'invoice_pay:card-1:2026-09' }, 'card-1')).toBe(2026 * 12 + 9);
    expect(invoicePaymentOrdinal({ attachmentUrl: 'invoice_pay:card-2:2026-9' }, 'card-1')).toBeNull();
    expect(invoicePaymentOrdinal({ attachmentUrl: 'invoice_pay:card-1:garbage' }, 'card-1')).toBeNull();
  });
});

describe('what is written', () => {
  it('writes the columns and the legacy text together, with the zero-based month in the text', () => {
    expect(invoicePaymentWrite(CARD, '2026-10')).toEqual({
      attachmentUrl: `invoice_pay:${CARD}:2026-9`,
      invoicePaymentAccountId: CARD,
      invoicePaymentMonth: '2026-10',
    });
    expect(invoicePaymentWrite(CARD, '2027-01').attachmentUrl).toBe(`invoice_pay:${CARD}:2027-0`);
    expect(invoicePaymentTag('card-1', '2026-03')).toBe('invoice_pay:card-1:2026-2');
  });

  it('reads back what it wrote', () => {
    expect(invoicePaymentLink(invoicePaymentWrite(CARD, '2026-12'))).toEqual({ accountId: CARD, month: '2026-12' });
  });

  it('derives the columns of a text sent by a client with the same strict rule as the migration backfill', () => {
    expect(invoicePaymentColumnsFromTag(`invoice_pay:${CARD}:2026-9`)).toEqual({ invoicePaymentAccountId: CARD, invoicePaymentMonth: '2026-10' });
    expect(invoicePaymentColumnsFromTag(`invoice_pay:${CARD}:2026-0`)).toEqual({ invoicePaymentAccountId: CARD, invoicePaymentMonth: '2026-01' });
    expect(invoicePaymentColumnsFromTag(`invoice_pay:${CARD}:2026-11`)).toEqual({ invoicePaymentAccountId: CARD, invoicePaymentMonth: '2026-12' });
    const none = { invoicePaymentAccountId: null, invoicePaymentMonth: null };
    // The cases the backfill left null on a real Postgres: not a uuid, padded month, month 12, garbage, no month,
    // trailing space or newline, prefix elsewhere, five-digit year, upper case, a plain URL and no text
    for (const text of [
      'invoice_pay:card-1:2026-9',
      `invoice_pay:${CARD}:2026-09`,
      `invoice_pay:${CARD}:2026-12`,
      `invoice_pay:${CARD}:garbage`,
      'invoice_pay:abc',
      `invoice_pay:${CARD}:2026-9 `,
      `invoice_pay:${CARD}:2026-9\n`,
      `x invoice_pay:${CARD}:2026-9`,
      `invoice_pay:${CARD}:20266-9`,
      `INVOICE_PAY:${CARD}:2026-9`,
      'https://example.com/receipt.pdf',
      null,
      undefined,
    ]) {
      expect(invoicePaymentColumnsFromTag(text), String(text)).toEqual(none);
    }
  });
});

// A minimal evaluator of the Prisma filter shapes the builders emit, so the row shapes can be run through them
type Row = Record<string, unknown>;
const asList = (cond: unknown): Row[] => (Array.isArray(cond) ? (cond as Row[]) : [cond as Row]);
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return asList(cond).some((w) => matches(row, w));
    if (key === 'AND') return asList(cond).every((w) => matches(row, w));
    if (key === 'NOT') return !asList(cond).some((w) => matches(row, w));
    const value = row[key] ?? null;
    if (cond === null || typeof cond !== 'object') return value === cond;
    const c = cond as { startsWith?: string; equals?: unknown; not?: unknown };
    // SQL: a comparison with NULL is never true (this is why the old filter spelled out `attachmentUrl: null`)
    if ('startsWith' in c) return typeof value === 'string' && value.startsWith(c.startsWith as string);
    if ('equals' in c) return value === c.equals;
    if ('not' in c) return value !== c.not;
    throw new Error(`unsupported condition on ${key}`);
  });
}

describe('the Prisma filters', () => {
  const purchase = { attachmentUrl: null, invoicePaymentAccountId: null, invoicePaymentMonth: null };
  const upload = { attachmentUrl: 'https://example.com/a.pdf', invoicePaymentAccountId: null, invoicePaymentMonth: null };
  const unreadable = { attachmentUrl: 'invoice_pay:abc', invoicePaymentAccountId: null, invoicePaymentMonth: null };
  const otherCard = { attachmentUrl: `invoice_pay:${OTHER}:2026-9`, invoicePaymentAccountId: OTHER, invoicePaymentMonth: '2026-10' };
  const otherMonth = { attachmentUrl: `invoice_pay:${CARD}:2026-8`, invoicePaymentAccountId: CARD, invoicePaymentMonth: '2026-09' };

  it.each(Object.entries(SHAPES))('"is a payment" takes the %s shape, and "is not a payment" leaves it out', (_name, row) => {
    expect(matches(row, isInvoicePaymentWhere())).toBe(true);
    expect(matches(row, notInvoicePaymentWhere())).toBe(false);
  });

  it('classifies the rows that are not readable payments like the old prefix check', () => {
    expect(matches(unreadable, isInvoicePaymentWhere())).toBe(true);
    expect(matches(unreadable, notInvoicePaymentWhere())).toBe(false);
    for (const row of [purchase, upload]) {
      expect(matches(row, isInvoicePaymentWhere())).toBe(false);
      expect(matches(row, notInvoicePaymentWhere())).toBe(true);
    }
  });

  it.each(Object.entries(SHAPES))('"payment of this card" takes the %s shape only for its card', (_name, row) => {
    expect(matches(row, invoicePaymentOfCardWhere(CARD))).toBe(true);
    expect(matches(row, invoicePaymentOfCardWhere(OTHER))).toBe(false);
  });

  it('"payment of this card" ignores purchases, uploads, unreadable tags and the payment of another card', () => {
    for (const row of [purchase, upload, unreadable, otherCard]) expect(matches(row, invoicePaymentOfCardWhere(CARD))).toBe(false);
  });

  it.each(Object.entries(SHAPES))('"payment of this invoice" takes the %s shape only for its card and month', (_name, row) => {
    expect(matches(row, invoicePaymentOfInvoiceWhere(CARD, '2026-10'))).toBe(true);
    expect(matches(row, invoicePaymentOfInvoiceWhere(CARD, '2026-09'))).toBe(false);
    expect(matches(row, invoicePaymentOfInvoiceWhere(OTHER, '2026-10'))).toBe(false);
  });

  it('"payment of this invoice" takes the right month of the same card', () => {
    expect(matches(otherMonth, invoicePaymentOfInvoiceWhere(CARD, '2026-09'))).toBe(true);
    expect(matches(otherMonth, invoicePaymentOfInvoiceWhere(CARD, '2026-10'))).toBe(false);
  });

  it('"payment of any of these cards" takes every shape of each card', () => {
    const where = { OR: [invoicePaymentOfCardWhere(CARD), invoicePaymentOfCardWhere(OTHER)] };
    for (const row of [legacy, both, columnsOnly, otherCard]) expect(matches(row, where)).toBe(true);
    for (const row of [purchase, upload, unreadable]) expect(matches(row, where)).toBe(false);
  });

  it('"without markers" keeps only the rows that have neither an attachment nor a payment link', () => {
    expect(matches(purchase, withoutPaymentMarkerWhere())).toBe(true);
    for (const row of [upload, legacy, both, columnsOnly, unreadable]) expect(matches(row, withoutPaymentMarkerWhere())).toBe(false);
  });

  it('builds the text filter of a card from the same tag the writer uses', () => {
    expect(invoiceTagOfCardWhere(CARD)).toEqual({ attachmentUrl: { startsWith: `invoice_pay:${CARD}:` } });
  });
});
