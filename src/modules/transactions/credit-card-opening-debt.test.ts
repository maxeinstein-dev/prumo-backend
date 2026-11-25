import { describe, expect, it } from 'vitest';

import { CategoryName, TransactionType } from '../../shared/enums/index.js';
import { openingDebtFromMovements } from './credit-card-opening-debt.js';

const card = 'card-1';
const dec = (n: number) => ({ toNumber: () => n });
const expense = (n: number) => ({
  accountId: card, amount: dec(n), type: TransactionType.EXPENSE, categoryName: CategoryName.OTHER_EXPENSES, attachmentUrl: null,
});
const payment = (n: number) => ({
  accountId: 'checking-1', amount: dec(n), type: TransactionType.EXPENSE, categoryName: CategoryName.OTHER_EXPENSES, attachmentUrl: `invoice_pay:${card}:2026-9`,
});
const refund = (n: number) => ({
  accountId: card, amount: dec(n), type: TransactionType.INCOME, categoryName: CategoryName.OTHER_INCOME, attachmentUrl: null,
});

describe('openingDebtFromMovements', () => {
  it.each([
    ['legacy text only', { attachmentUrl: `invoice_pay:${card}:2026-9`, invoicePaymentAccountId: null }],
    ['columns and text', { attachmentUrl: `invoice_pay:${card}:2026-9`, invoicePaymentAccountId: card, invoicePaymentMonth: '2026-10' }],
    ['columns only', { attachmentUrl: null, invoicePaymentAccountId: card, invoicePaymentMonth: '2026-10' }],
  ])('takes a payment off the debt the same way in every shape of the link (%s)', (_name, link) => {
    const paid = { ...payment(0.2), ...link };
    expect(openingDebtFromMovements(dec(10), [expense(0.1), expense(0.2), refund(0.1), paid], card)).toBe(10);
    // a payment of another card is not a movement of this one
    expect(openingDebtFromMovements(dec(10), [{ ...paid, invoicePaymentAccountId: link.invoicePaymentAccountId ? 'card-2' : null, attachmentUrl: 'invoice_pay:card-2:2026-9' }], card)).toBe(10);
  });

  it('is exact to the cent where float sums drift (0.6 - (0.1 + 0.2 + 0.1))', () => {
    expect(openingDebtFromMovements(dec(0.6), [expense(0.1), expense(0.2), expense(0.1)], card)).toBe(0.2);
  });

  it('counts payments and refunds as debt reductions', () => {
    // balance 10.00 = opening + 0.30 expenses - 0.10 refund - 0.20 payment  =>  opening 10.00
    expect(openingDebtFromMovements(dec(10), [expense(0.1), expense(0.2), refund(0.1), payment(0.2)], card)).toBe(10);
  });

  it('never goes below zero', () => {
    expect(openingDebtFromMovements(dec(1), [expense(5)], card)).toBe(0);
  });

  it('with no movements the opening debt is the balance', () => {
    expect(openingDebtFromMovements(dec(12.34), [], card)).toBe(12.34);
  });
});
