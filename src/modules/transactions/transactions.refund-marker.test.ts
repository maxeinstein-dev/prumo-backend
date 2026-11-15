import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/db/prisma.js', () => ({ prisma: {} }));

const { assertValidRefund } = await import('./transactions.service.js');
const { createTransactionSchema, updateTransactionSchema } = await import('./transactions.schema.js');

// Only an INCOME row can be a refund (it cancels an expense); the API refuses the marker anywhere else.
describe('refund marker validation', () => {
  it('accepts the marker on income and refuses it on any other type', () => {
    expect(() => assertValidRefund(true, 'INCOME')).not.toThrow();
    expect(() => assertValidRefund(false, 'EXPENSE')).not.toThrow();
    for (const type of ['EXPENSE', 'TRANSFER', 'ALLOCATION']) {
      expect(() => assertValidRefund(true, type), type).toThrow(/isRefund only applies to INCOME/);
    }
  });

  it('create and update accept a boolean isRefund and nothing else', () => {
    const base = { accountId: '00000000-0000-4000-8000-000000000001', categoryName: 'GROCERIES', amount: 30, date: '2026-10-12', type: 'INCOME' };
    expect(createTransactionSchema.safeParse({ ...base, isRefund: true }).success).toBe(true);
    expect(createTransactionSchema.safeParse({ ...base, isRefund: 'yes' }).success).toBe(false);
    expect(updateTransactionSchema.safeParse({ isRefund: true }).success).toBe(true);
    expect(updateTransactionSchema.safeParse({ isRefund: 1 }).success).toBe(false);
  });
});
