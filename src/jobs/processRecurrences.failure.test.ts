import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetStore, rowById, seedAccount, seedRecurrence } from '../modules/recurring-transactions/__fixtures__/recurring-fake-db.js';
import * as service from '../modules/recurring-transactions/recurring-transactions.service.js';
import { processDueRecurringTransactions } from './processRecurrences.js';

vi.mock('../shared/config/env.js', () => ({ env: {} }));
vi.mock('../shared/db/prisma.js', async () => ({
  prisma: (await import('../modules/recurring-transactions/__fixtures__/recurring-fake-db.js')).fakePrisma,
}));
vi.mock('../shared/services/balance.service.js', () => ({
  updateBalanceForNormalTransaction: vi.fn(async () => undefined),
  recalculateCreditCardLimit: vi.fn(async () => undefined),
}));
vi.mock('../modules/recurring-transactions/recurring-transactions.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/recurring-transactions/recurring-transactions.service.js')>();
  return { ...actual, executeRecurringTransaction: vi.fn(actual.executeRecurringTransaction) };
});

// Invented data only.
const HH = 'hh-1';
const ACC = 'acc-1';
const realTz = process.env.TZ;

beforeEach(() => {
  resetStore();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  seedAccount({ id: ACC, householdId: HH, name: 'Conta Teste', type: 'CHECKING', balance: 0 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (realTz === undefined) delete process.env.TZ;
  else process.env.TZ = realTz;
});

describe('processRecurrences job: failures', () => {
  it('keeps processing the others, then throws naming only the ids of the ones that failed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
    const bad = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Segredo Alfa', amount: 111.11, nextRunAt: '2026-11-24' });
    const good = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Conta Beta', amount: 22.22, nextRunAt: '2026-11-24' });
    const real = await vi.importActual<typeof import('../modules/recurring-transactions/recurring-transactions.service.js')>(
      '../modules/recurring-transactions/recurring-transactions.service.js'
    );
    vi.mocked(service.executeRecurringTransaction).mockImplementation(async (id, household, input) => {
      if (id === bad.id) throw new Error('boom 111.11 Segredo Alfa');
      return real.executeRecurringTransaction(id, household, input);
    });

    const run = processDueRecurringTransactions();
    await expect(run).rejects.toThrow(bad.id);
    const message = String(await run.catch((e: Error) => e.message));
    expect(message).not.toContain(good.id);
    expect(message).not.toContain('Segredo');
    expect(message).not.toContain('111.11');
    expect(rowById('recurringTransaction', good.id).lastRunDate).toBe('2026-11-24');
  });

  it('does not throw when every recurrence succeeds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
    seedRecurrence({ householdId: HH, accountId: ACC, description: 'Conta Beta', amount: 22.22, nextRunAt: '2026-11-24' });
    await expect(processDueRecurringTransactions()).resolves.toBeUndefined();
  });
});

describe('processRecurrences job: today is the UTC day', () => {
  it('late evening in Sao Paulo (already the next day in UTC) runs the recurrence due on the UTC day', async () => {
    process.env.TZ = 'America/Sao_Paulo';
    vi.useFakeTimers({ toFake: ['Date'] });
    // 22:30 on 24/11 in Sao Paulo = 01:30 on 25/11 in UTC
    vi.setSystemTime(new Date('2026-11-25T01:30:00Z'));
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Conta Beta', amount: 22.22, nextRunAt: '2026-11-25' });
    await processDueRecurringTransactions();
    expect(rowById('recurringTransaction', rec.id).lastRunDate).toBe('2026-11-25');
  });
});
