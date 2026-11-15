import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetStore,
  rowsOf,
  seedAccount,
  seedDefaultShare,
  seedPerson,
  seedRecurrence,
  seedShare,
  seedTransaction,
} from './__fixtures__/recurring-fake-db.js';
import {
  createRecurringTransaction,
  executeRecurringTransaction,
  getRecurringTransaction,
  listRecurringTransactions,
  updateRecurringTransaction,
} from './recurring-transactions.service.js';

vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('./__fixtures__/recurring-fake-db.js')).fakePrisma,
}));
vi.mock('../../shared/services/balance.service.js', () => ({
  updateBalanceForNormalTransaction: vi.fn(async () => undefined),
  recalculateCreditCardLimit: vi.fn(async () => undefined),
}));

// Invented data only.
const HH = 'hh-1';
const ACC = '11111111-1111-4111-8111-111111111111';
const MAE = '22222222-2222-4222-8222-222222222222';
const ANA = '33333333-3333-4333-8333-333333333333';
const GONE = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  seedAccount({ id: ACC, householdId: HH, name: 'Conta Teste', balance: 1000 });
  seedPerson({ id: MAE, householdId: HH, name: 'Mae Teste' });
  seedPerson({ id: ANA, householdId: HH, name: 'Ana Teste' });
  seedPerson({ id: GONE, householdId: HH, name: 'Pessoa Inativa', isActive: false });
});

const occurrences = (recurringId: string) => rowsOf('transaction').filter((t) => t.recurringTransactionId === recurringId);
const sharesOf = (transactionId: string) => rowsOf('transactionShare').filter((s) => s.transactionId === transactionId);

describe('default split applied to the generated occurrence (P19 L1)', () => {
  it('100% to another person: the occurrence is born already split', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Internet Teste', amount: 208.99, nextRunAt: '2026-12-10' });
    seedDefaultShare({ householdId: HH, recurringTransactionId: rec.id, personId: MAE, percent: 100 });
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 11, 10) });
    const [occurrence] = occurrences(rec.id);
    expect(sharesOf(occurrence!.id)).toEqual([
      expect.objectContaining({ householdId: HH, personId: MAE, amount: 208.99, direction: 'THEY_OWE_ME', source: 'recurring' }),
    ]);
  });

  it('50% of an amount that does not divide in cents', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia Teste', amount: 100.01, nextRunAt: '2026-12-10' });
    seedDefaultShare({ householdId: HH, recurringTransactionId: rec.id, personId: ANA, percent: 50 });
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 11, 10) });
    expect(sharesOf(occurrences(rec.id)[0]!.id)).toEqual([expect.objectContaining({ personId: ANA, amount: 50 })]);
  });

  it('the percent follows the real amount of the occurrence (paid ahead with another value)', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia Teste', amount: 100, nextRunAt: '2026-12-10' });
    seedDefaultShare({ householdId: HH, recurringTransactionId: rec.id, personId: ANA, percent: 50 });
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 11, 8) }, { amount: 187.5 });
    expect(sharesOf(occurrences(rec.id)[0]!.id)).toEqual([expect.objectContaining({ personId: ANA, amount: 93.75 })]);
  });

  it('a recurrence without a default split keeps the occurrence whole (behaviour before P19)', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Agua Teste', amount: 80, nextRunAt: '2026-12-10' });
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 11, 10) });
    expect(occurrences(rec.id)).toHaveLength(1);
    expect(rowsOf('transactionShare')).toHaveLength(0);
  });

  it('an inactive person gets no part', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia Teste', amount: 100, nextRunAt: '2026-12-10' });
    seedDefaultShare({ householdId: HH, recurringTransactionId: rec.id, personId: GONE, percent: 50 });
    seedDefaultShare({ householdId: HH, recurringTransactionId: rec.id, personId: ANA, percent: 25 });
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 11, 10) });
    expect(sharesOf(occurrences(rec.id)[0]!.id)).toEqual([expect.objectContaining({ personId: ANA, amount: 25 })]);
  });

  it('an income recurrence is never split by default', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Salario Teste', amount: 1000, nextRunAt: '2026-12-10', categoryName: 'SALARY' });
    seedDefaultShare({ householdId: HH, recurringTransactionId: rec.id, personId: ANA, percent: 50 });
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 11, 10) });
    expect(occurrences(rec.id)).toHaveLength(1);
    expect(rowsOf('transactionShare')).toHaveLength(0);
  });

  it('a split failure never blocks the occurrence: a skipped month (already generated) gets no new shares', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia Teste', amount: 100, nextRunAt: '2026-12-10' });
    seedDefaultShare({ householdId: HH, recurringTransactionId: rec.id, personId: ANA, percent: 50 });
    const existing = seedTransaction({ householdId: HH, accountId: ACC, description: 'Energia Teste', amount: 100, date: '2026-12-03', recurringTransactionId: rec.id });
    const result = await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 11, 10) });
    expect(result.skipped).toBe(true);
    expect(sharesOf(existing.id)).toHaveLength(0);
  });
});

describe('default split applied to an imported row the recurrence adopts (P19 L1)', () => {
  it('the adopted row gets the default split', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Internet Teste', amount: 208.99, nextRunAt: '2026-12-10' });
    seedDefaultShare({ householdId: HH, recurringTransactionId: rec.id, personId: MAE, percent: 100 });
    const imported = seedTransaction({ householdId: HH, accountId: ACC, description: 'INTERNET TESTE', amount: 210.5, date: '2026-12-04', sourceRef: 'ofx:1' });
    const result = await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 11, 10) });
    expect(result.skipped).toBe(true);
    expect(sharesOf(imported.id)).toEqual([expect.objectContaining({ personId: MAE, amount: 210.5, source: 'recurring' })]);
  });

  it('never overwrites a split made by hand on the adopted row', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Internet Teste', amount: 208.99, nextRunAt: '2026-12-10' });
    seedDefaultShare({ householdId: HH, recurringTransactionId: rec.id, personId: MAE, percent: 100 });
    const imported = seedTransaction({ householdId: HH, accountId: ACC, description: 'INTERNET TESTE', amount: 200, date: '2026-12-04', sourceRef: 'ofx:1' });
    seedShare({ householdId: HH, transactionId: imported.id, personId: ANA, amount: 20 });
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 11, 10) });
    expect(sharesOf(imported.id)).toEqual([expect.objectContaining({ personId: ANA, amount: 20, source: 'manual' })]);
  });
});

describe('default split on the recurrence itself (P19 L1)', () => {
  const base = {
    householdId: HH,
    accountId: ACC,
    categoryName: 'UTILITIES',
    amount: 208.99,
    description: 'Internet Teste',
    frequency: 'MONTHLY' as const,
    startDate: new Date(2027, 0, 10),
    nextRunAt: new Date(2027, 0, 10),
    isActive: true,
    followLastAmount: false,
    forecastStrategy: 'LAST' as const,
    safetyBusinessDays: 0,
    nonWorkingDays: [],
    optionalHolidays: [],
    aliases: [],
  };

  it('create stores the default split and get/list return it with the names', async () => {
    const created = await createRecurringTransaction({ ...base, defaultShares: [{ personId: MAE, percent: 100 }] } as never);
    expect(rowsOf('recurringTransactionShare')).toEqual([expect.objectContaining({ recurringTransactionId: created.id, personId: MAE, percent: 100, amount: null })]);
    expect(created.defaultShares).toEqual([{ personId: MAE, personName: 'Mae Teste', percent: 100, amount: null }]);
    expect((await getRecurringTransaction(created.id)).defaultShares).toEqual(created.defaultShares);
    const [listed] = await listRecurringTransactions({ householdId: HH });
    expect(listed!.defaultShares).toEqual(created.defaultShares);
  });

  it('update replaces the split, null clears it, and leaving it out keeps it', async () => {
    const created = await createRecurringTransaction({ ...base, defaultShares: [{ personId: MAE, percent: 100 }] } as never);
    await updateRecurringTransaction(created.id, HH, { defaultShares: [{ personId: ANA, amount: 50 }] } as never);
    expect(rowsOf('recurringTransactionShare')).toEqual([expect.objectContaining({ personId: ANA, percent: null, amount: 50 })]);
    await updateRecurringTransaction(created.id, HH, { description: 'Internet Teste 2' } as never);
    expect(rowsOf('recurringTransactionShare')).toHaveLength(1);
    const cleared = await updateRecurringTransaction(created.id, HH, { defaultShares: null } as never);
    expect(rowsOf('recurringTransactionShare')).toHaveLength(0);
    expect(cleared.defaultShares).toEqual([]);
  });

  it('an edit that resends the stored split keeps working after its person was deactivated, a new inactive person is still refused', async () => {
    const created = await createRecurringTransaction({ ...base, defaultShares: [{ personId: MAE, percent: 100 }] } as never);
    rowsOf('person').find((p) => p.id === MAE)!.isActive = false;
    const edited = await updateRecurringTransaction(created.id, HH, { amount: 210, defaultShares: [{ personId: MAE, percent: 100 }] } as never);
    expect(edited.amount).toBe(210);
    expect(rowsOf('recurringTransactionShare')).toEqual([expect.objectContaining({ personId: MAE, percent: 100 })]);
    // GONE was never in this split: still refused
    await expect(updateRecurringTransaction(created.id, HH, { defaultShares: [{ personId: GONE, percent: 50 }] } as never)).rejects.toThrow(/inactive/);
  });

  it('refuses an inactive person or one of another household, saving nothing', async () => {
    await expect(createRecurringTransaction({ ...base, defaultShares: [{ personId: GONE, percent: 50 }] } as never)).rejects.toThrow(/inactive/);
    await expect(createRecurringTransaction({ ...base, defaultShares: [{ personId: '55555555-5555-4555-8555-555555555555', percent: 50 }] } as never)).rejects.toThrow(/Person/);
    expect(rowsOf('recurringTransaction')).toHaveLength(0);
    expect(rowsOf('recurringTransactionShare')).toHaveLength(0);
  });
});
