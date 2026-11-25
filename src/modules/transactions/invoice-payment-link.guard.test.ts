import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural guard: the link "this transaction pays the invoice of card X" lives in two places (the columns and the
 * legacy text marker in attachmentUrl) and is read and written only through invoice-payment-link.ts. A production file
 * that spells the marker itself (a startsWith on the text, a regex over it, a hand-built tag) reads one of the two places
 * and silently misses the rows that only have the other, so a budget, a cash flow or an invoice would add up differently
 * for an old row and a new one. Ask the module (invoicePaymentLink, isInvoicePayment, the Prisma filters) instead.
 *
 * The scan covers comments too, on purpose: a comment that teaches the old format invites the next reader to copy it.
 * Tests, fixtures and the generated Prisma client are not production code.
 */
const MARKER = /invoice_pay(?!ment)/;
const ALLOWED = new Set(['src/modules/transactions/invoice-payment-link.ts']);

export function spellsTheMarker(source: string): boolean {
  return MARKER.test(source);
}

function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__fixtures__' || name === 'generated' || name === 'scripts' ? [] : productionFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('the invoice payment marker', () => {
  it('is spelled only by invoice-payment-link.ts in production code', () => {
    const found = productionFiles('src')
      .filter((file) => spellsTheMarker(readFileSync(file, 'utf8')))
      .map((file) => relative('.', file).split(sep).join('/'))
      .sort();
    expect(found).toEqual([...ALLOWED]);
  });

  describe('the scanner (negative and positive fixtures)', () => {
    it('flags the text marker in code and in a comment', () => {
      expect(spellsTheMarker("if (t.attachmentUrl?.startsWith('invoice_pay:')) skip();")).toBe(true);
      expect(spellsTheMarker('const tag = `invoice_pay:${id}:${key}`;')).toBe(true);
      expect(spellsTheMarker('// tagged invoice_pay:<card>:<month>')).toBe(true);
    });

    it('accepts the column names and ordinary code', () => {
      expect(spellsTheMarker('select: { invoicePaymentAccountId: true }')).toBe(false);
      expect(spellsTheMarker('ALTER TABLE t ADD COLUMN invoice_payment_account_id UUID')).toBe(false);
      expect(spellsTheMarker("import { isInvoicePayment } from './invoice-payment-link.js';")).toBe(false);
    });
  });
});
