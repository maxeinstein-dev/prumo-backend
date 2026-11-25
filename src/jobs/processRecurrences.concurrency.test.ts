import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetStore, rowById, rowsOf, seedAccount, seedRecurrence } from '../modules/recurring-transactions/__fixtures__/recurring-fake-db.js';
import { executeRecurringTransaction } from '../modules/recurring-transactions/recurring-transactions.service.js';
import { processDueRecurringTransactions } from './processRecurrences.js';

vi.mock('../shared/config/env.js', () => ({ env: {} }));
vi.mock('../shared/db/prisma.js', async () => ({
  prisma: (await import('../modules/recurring-transactions/__fixtures__/recurring-fake-db.js')).fakePrisma,
}));
vi.mock('../shared/services/balance.service.js', () => ({
  updateBalanceForNormalTransaction: vi.fn(async () => undefined),
  recalculateCreditCardLimit: vi.fn(async () => undefined),
}));

// Invented data only. Two writers of the same occurrence running at the same time (the in-memory database interleaves
// concurrent calls at every await, and its advisory lock makes a second transaction wait like Postgres does).
const HH = 'hh-1';
const ACC = 'acc-bank';

beforeEach(() => {
  resetStore();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 24, 5, 40));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  seedAccount({ id: ACC, householdId: HH, name: 'Conta Teste', balance: 1000 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const occurrences = (id: string) => rowsOf('transaction').filter((t) => t.recurringTransactionId === id);

describe.each(['MONTHLY', 'WEEKLY', 'DAILY', 'BIWEEKLY', 'YEARLY'] as const)('simultaneous runs of a %s recurrence', (frequency) => {
  const make = () => seedRecurrence({ householdId: HH, accountId: ACC, description: 'Servico Teste', amount: 80, nextRunAt: '2026-11-24', frequency });

  it('job x job creates one occurrence', async () => {
    const rec = make();
    await Promise.all([processDueRecurringTransactions(), processDueRecurringTransactions()]);
    expect(occurrences(rec.id)).toHaveLength(1);
    expect(rowById('recurringTransaction', rec.id).lastRunDate).toBe('2026-11-24');
  });

  it('job x "run now" creates one occurrence', async () => {
    const rec = make();
    await Promise.all([processDueRecurringTransactions(), executeRecurringTransaction(rec.id, HH, {})]);
    expect(occurrences(rec.id)).toHaveLength(1);
  });

  it('"run now" x "run now" (two clicks) creates one occurrence', async () => {
    const rec = make();
    const results = await Promise.all([executeRecurringTransaction(rec.id, HH, {}), executeRecurringTransaction(rec.id, HH, {})]);
    expect(occurrences(rec.id)).toHaveLength(1);
    expect(results.filter((r) => !r.skipped)).toHaveLength(1);
    // Both moved the recurrence from the same occurrence: it advanced once, not twice.
    const next = rowById('recurringTransaction', rec.id).nextRunAt;
    expect(results[0]!.nextRunAt.toISOString().slice(0, 10)).toBe(next);
    expect(results[1]!.nextRunAt.toISOString().slice(0, 10)).toBe(next);
  });
});
