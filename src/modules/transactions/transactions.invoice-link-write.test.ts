import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetStore, rowById, rowsOf, seedAccount, seedTransaction } from '../recurring-transactions/__fixtures__/recurring-fake-db.js';
import { createTransaction, updateTransaction } from './transactions.service.js';

vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('../recurring-transactions/__fixtures__/recurring-fake-db.js')).fakePrisma,
}));
vi.mock('../../shared/services/balance.service.js', () => ({
  updateBalanceForNormalTransaction: vi.fn(async () => undefined),
  recalculateCreditCardLimit: vi.fn(async () => undefined),
}));
vi.mock('../notifications/budget-notifications.service.js', () => ({ checkBudgetThresholds: vi.fn(async () => undefined) }));

// Invented data only.
const HH = 'hh-1';
const ACC = 'acc-bank';
const CARD = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  seedAccount({ id: ACC, householdId: HH, name: 'Conta Teste', balance: 1000 });
});

describe('the invoice payment link written by create and update', () => {
  const input = { householdId: HH, accountId: ACC, categoryName: 'OTHER_EXPENSES', type: 'EXPENSE' as const, amount: 80, description: 'Pagamento', date: new Date(2026, 9, 6), paid: true, isSplit: false };

  it('create: a well-formed marker text also fills the columns', async () => {
    await createTransaction({ ...input, attachmentUrl: `invoice_pay:${CARD}:2026-9` } as never);
    expect(rowsOf('transaction')[0]).toMatchObject({
      attachmentUrl: `invoice_pay:${CARD}:2026-9`,
      invoicePaymentAccountId: CARD,
      invoicePaymentMonth: '2026-10',
    });
  });

  it('create: a plain URL, a marker that is not strictly well formed, and no attachment leave the columns empty', async () => {
    await createTransaction({ ...input, attachmentUrl: 'https://example.com/a.pdf' } as never);
    await createTransaction({ ...input, attachmentUrl: 'invoice_pay:abc' } as never);
    await createTransaction(input as never);
    for (const row of rowsOf('transaction')) expect(row.invoicePaymentAccountId ?? null).toBeNull();
    for (const row of rowsOf('transaction')) expect(row.invoicePaymentMonth ?? null).toBeNull();
  });

  it('update: changing the text moves the columns with it', async () => {
    const t = seedTransaction({ householdId: HH, accountId: ACC, amount: 80, description: 'Pagamento', type: 'EXPENSE', categoryName: 'OTHER_EXPENSES', date: '2026-10-06', paid: true });
    await updateTransaction(t.id, HH, { attachmentUrl: `invoice_pay:${CARD}:2026-9` });
    expect(rowById('transaction', t.id)).toMatchObject({ invoicePaymentAccountId: CARD, invoicePaymentMonth: '2026-10' });
    await updateTransaction(t.id, HH, { attachmentUrl: `invoice_pay:${CARD}:2026-10` });
    expect(rowById('transaction', t.id)).toMatchObject({ invoicePaymentAccountId: CARD, invoicePaymentMonth: '2026-11' });
  });

  it('update: clearing or replacing the text clears the columns (the row stops being a payment, as before)', async () => {
    const t = seedTransaction({
      householdId: HH, accountId: ACC, amount: 80, description: 'Pagamento', type: 'EXPENSE', categoryName: 'OTHER_EXPENSES', date: '2026-10-06', paid: true,
      attachmentUrl: `invoice_pay:${CARD}:2026-9`, invoicePaymentAccountId: CARD, invoicePaymentMonth: '2026-10',
    });
    await updateTransaction(t.id, HH, { attachmentUrl: null });
    expect(rowById('transaction', t.id)).toMatchObject({ attachmentUrl: null, invoicePaymentAccountId: null, invoicePaymentMonth: null });

    await updateTransaction(t.id, HH, { attachmentUrl: `invoice_pay:${CARD}:2026-9` });
    await updateTransaction(t.id, HH, { attachmentUrl: 'https://example.com/a.pdf' });
    expect(rowById('transaction', t.id)).toMatchObject({ invoicePaymentAccountId: null, invoicePaymentMonth: null });
  });

  it('update: an update that does not mention the attachment leaves the link alone', async () => {
    const t = seedTransaction({
      householdId: HH, accountId: ACC, amount: 80, description: 'Pagamento', type: 'EXPENSE', categoryName: 'OTHER_EXPENSES', date: '2026-10-06', paid: true,
      attachmentUrl: `invoice_pay:${CARD}:2026-9`, invoicePaymentAccountId: CARD, invoicePaymentMonth: '2026-10',
    });
    await updateTransaction(t.id, HH, { description: 'Pagamento da fatura' });
    expect(rowById('transaction', t.id)).toMatchObject({ attachmentUrl: `invoice_pay:${CARD}:2026-9`, invoicePaymentAccountId: CARD, invoicePaymentMonth: '2026-10' });
  });
});
