import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { creditCardInvoiceParamsSchema, payInvoiceSchema } from './transactions.schema.js';
import { invoicePaymentOfInvoiceWhere, invoicePaymentOrdinal, invoicePaymentTag, invoicePaymentWrite } from './invoice-payment-link.js';

const CARD = '22222222-2222-4222-8222-222222222222';
const BAD = ['2026-13', '2026-00', '2026-99', '2026-1', '26-10'];
const GOOD = ['2026-01', '2026-09', '2026-10', '2026-12'];

describe('invoice month validation', () => {
  it.each(BAD)('rejects %s in the invoice query params', (month) => {
    expect(creditCardInvoiceParamsSchema.safeParse({ accountId: CARD, month }).success).toBe(false);
  });
  it.each(GOOD)('accepts %s in the invoice query params', (month) => {
    expect(creditCardInvoiceParamsSchema.safeParse({ accountId: CARD, month }).success).toBe(true);
  });
  it.each(BAD)('rejects %s when paying an invoice', (month) => {
    expect(payInvoiceSchema.safeParse({ sourceAccountId: CARD, month }).success).toBe(false);
  });
  it.each(GOOD)('accepts %s when paying an invoice', (month) => {
    expect(payInvoiceSchema.safeParse({ sourceAccountId: CARD, month }).success).toBe(true);
  });

  it.each(['2026-13', '2026-00'])('invoicePaymentTag refuses %s instead of moving to a neighbouring month', (month) => {
    expect(() => invoicePaymentTag(CARD, month)).toThrow('Invalid invoice month');
    expect(() => invoicePaymentWrite(CARD, month)).toThrow();
    expect(() => invoicePaymentOfInvoiceWhere(CARD, month)).toThrow();
  });
  it('still tags every real month', () => {
    expect(invoicePaymentTag(CARD, '2026-12')).toBe(`invoice_pay:${CARD}:2026-11`);
    expect(invoicePaymentTag(CARD, '2026-01')).toBe(`invoice_pay:${CARD}:2026-0`);
  });
  it('reads an unreadable stored month as null', () => {
    expect(invoicePaymentOrdinal({ invoicePaymentAccountId: CARD, invoicePaymentMonth: '2026-13' }, CARD)).toBeNull();
  });

  it('keeps the route JSON schemas of the invoice routes as strict as the Zod ones', () => {
    const src = readFileSync(new URL('./transactions.routes.ts', import.meta.url), 'utf8');
    for (const marker of ['Get credit card invoice details for a specific month', "required: ['sourceAccountId', 'month']"]) {
      const at = src.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      const pat = /month: \{ type: 'string', pattern: '([^']+)' \}/.exec(src.slice(at))![1];
      expect(pat).toBe(String.raw`^\\d{4}-(0[1-9]|1[0-2])$`);
    }
  });
});
