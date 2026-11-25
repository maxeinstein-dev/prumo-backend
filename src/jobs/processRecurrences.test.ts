import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetStore, rowById, rowsOf, seedAccount, seedRecurrence, seedTransaction } from '../modules/recurring-transactions/__fixtures__/recurring-fake-db.js';
import { processDueRecurringTransactions } from './processRecurrences.js';

vi.mock('../shared/config/env.js', () => ({ env: {} }));
vi.mock('../shared/db/prisma.js', async () => ({
  prisma: (await import('../modules/recurring-transactions/__fixtures__/recurring-fake-db.js')).fakePrisma,
}));
vi.mock('../shared/services/balance.service.js', () => ({
  updateBalanceForNormalTransaction: vi.fn(async () => undefined),
  recalculateCreditCardLimit: vi.fn(async () => undefined),
}));

// Invented data only. The daily job on the due day of a monthly card recurrence.
const HH = 'hh-1';
const CARD = 'acc-card';

beforeEach(() => {
  resetStore();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 24, 5, 40));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  seedAccount({ id: CARD, householdId: HH, name: 'Cartao Teste', type: 'CREDIT', balance: 0 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const recurrence = () =>
  seedRecurrence({ householdId: HH, accountId: CARD, description: 'Seguro Beta', amount: 118.47, nextRunAt: '2026-11-18', aliases: ['Pg *Betaseg Digital'] });

describe('processRecurrences job', () => {
  it('does not duplicate the charge captured and confirmed the day before: links it and moves on', async () => {
    const rec = recurrence();
    const capture = seedTransaction({
      householdId: HH, accountId: CARD, description: 'Pg *Betaseg Digital', amount: 118.47, date: '2026-11-17', paid: true, sourceRef: 'notif:abc',
    } as never);
    await processDueRecurringTransactions();
    expect(rowsOf('transaction')).toHaveLength(1);
    expect(rowById('transaction', capture.id).recurringTransactionId).toBe(rec.id);
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ nextRunAt: '2026-12-18', lastRunDate: '2026-11-18', isActive: true });
  });

  it('creates the occurrence when nothing was entered', async () => {
    const rec = recurrence();
    await processDueRecurringTransactions();
    const created = rowsOf('transaction').filter((t) => t.recurringTransactionId === rec.id);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ description: 'Seguro Beta', date: '2026-11-18', amount: 118.47, paid: true });
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ nextRunAt: '2026-12-18' });
  });
});
