import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakePrisma, resetStore, rowById, rowsOf, seedAccount, seedRecurrence, seedTransaction } from './__fixtures__/recurring-fake-db.js';
import { executeRecurringTransaction } from './recurring-transactions.service.js';

vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('./__fixtures__/recurring-fake-db.js')).fakePrisma,
}));
vi.mock('../../shared/services/balance.service.js', () => ({
  updateBalanceForNormalTransaction: vi.fn(async () => undefined),
  recalculateCreditCardLimit: vi.fn(async () => undefined),
}));

// Invented data only.
const HH = 'hh-1';
const ACC = 'acc-bank';
const OTHER_ACC = 'acc-other';

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  seedAccount({ id: ACC, householdId: HH, name: 'Conta Teste', balance: 1000 });
  seedAccount({ id: OTHER_ACC, householdId: HH, name: 'Outra Conta', balance: 500 });
});

const run = (id: string, day = new Date(2026, 9, 5)) => executeRecurringTransaction(id, HH, { date: day, paid: false });
const linked = (id: string) => rowsOf('transaction').filter((t) => t.recurringTransactionId === id);

function imported(overrides: Record<string, unknown> = {}) {
  return seedTransaction({
    householdId: HH, accountId: ACC, description: 'Pg *Seguro Alfa Digital', amount: 87.4, date: '2026-10-03', paid: true,
    sourceRef: 'ofx:FIT-1', ...overrides,
  } as never);
}

describe('executeRecurringTransaction adopts an imported transaction of the month', () => {
  it('duplicates nothing when the imported row has the recurrence name (the reported bug)', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Seguro Alfa', amount: 90, nextRunAt: '2026-10-05' });
    const tx = imported({ description: 'seguro  ALFA' });
    const result = await run(rec.id);
    expect(result.skipped).toBe(true);
    expect(rowsOf('transaction')).toHaveLength(1);
    expect(rowById('transaction', tx.id).recurringTransactionId).toBe(rec.id);
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ nextRunAt: '2026-11-05', lastRunDate: '2026-10-05' });
  });

  it('an unrelated bank name without alias creates the occurrence as before', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Seguro Alfa', amount: 90, nextRunAt: '2026-10-05' });
    const tx = imported({ description: 'Pg *Digital Seguros' });
    const result = await run(rec.id);
    expect(result.skipped).toBe(false);
    expect(rowsOf('transaction')).toHaveLength(2);
    expect(rowById('transaction', tx.id).recurringTransactionId).toBeNull();
  });

  it('adopts through an alias, whatever the amount, and leaves the row untouched', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Seguro Alfa', amount: 90, nextRunAt: '2026-10-05', aliases: ["Pg *Seguro Alfa Digital"] });
    const tx = imported();
    const before = { ...tx };
    const result = await run(rec.id);
    expect(result.skipped).toBe(true);
    expect(result.transaction.id).toBe(tx.id);
    expect(rowsOf('transaction')).toHaveLength(1);
    expect({ ...rowById('transaction', tx.id), recurringTransactionId: null }).toEqual({ ...before, recurringTransactionId: null });
    expect(rowById('transaction', tx.id).recurringTransactionId).toBe(rec.id);
    expect(rowById('account', ACC).balance).toBe(1000);
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ nextRunAt: '2026-11-05' });
  });

  it('an income recurrence never adopts an expense with the same description', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Mesada', amount: 300, nextRunAt: '2026-10-05', categoryName: 'SALARY' });
    const tx = imported({ description: 'Mesada', type: 'EXPENSE' });
    const result = await run(rec.id);
    expect(result.skipped).toBe(false);
    expect(rowById('transaction', tx.id).recurringTransactionId).toBeNull();
  });

  it('an expense recurrence does not adopt an income with the same description', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Mesada', amount: 300, nextRunAt: '2026-10-05' });
    const tx = imported({ description: 'Mesada', type: 'INCOME' });
    expect((await run(rec.id)).skipped).toBe(false);
    expect(rowById('transaction', tx.id).recurringTransactionId).toBeNull();
  });

  it('does not adopt another account, a row too early or in the next month, a row already linked or another household', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Seguro Alfa', amount: 90, nextRunAt: '2026-10-05' });
    const other = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Outro', amount: 1, nextRunAt: '2026-12-01' });
    const elsewhere = imported({ description: 'Seguro Alfa', sourceRef: 'ofx:2', accountId: OTHER_ACC });
    const tooEarly = imported({ description: 'Seguro Alfa', sourceRef: 'ofx:3', date: '2026-09-27' });
    const nextMonth = imported({ description: 'Seguro Alfa', sourceRef: 'ofx:4', date: '2026-11-01' });
    const taken = imported({ description: 'Seguro Alfa', sourceRef: 'ofx:5', recurringTransactionId: other.id });
    const foreign = imported({ description: 'Seguro Alfa', sourceRef: 'ofx:6', householdId: 'hh-2' });
    const result = await run(rec.id);
    expect(result.skipped).toBe(false);
    for (const t of [elsewhere, tooEarly, nextMonth, foreign]) expect(rowById('transaction', t.id).recurringTransactionId).toBeNull();
    expect(rowById('transaction', taken.id).recurringTransactionId).toBe(other.id);
  });

  it('with several candidates adopts only the oldest and creates nothing', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Seguro Alfa', amount: 90, nextRunAt: '2026-10-05' });
    const later = imported({ description: 'Seguro Alfa', sourceRef: 'ofx:b', date: '2026-10-20' });
    const first = imported({ description: 'Seguro Alfa', sourceRef: 'ofx:a', date: '2026-10-02' });
    const result = await run(rec.id);
    expect(result.skipped).toBe(true);
    expect(rowsOf('transaction')).toHaveLength(2);
    expect(rowById('transaction', first.id).recurringTransactionId).toBe(rec.id);
    expect(rowById('transaction', later.id).recurringTransactionId).toBeNull();
  });

  it('does not use the "Planilha:" note as a name', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Seguro Alfa', amount: 90, nextRunAt: '2026-10-05' });
    const tx = imported({ description: 'Pg *Digital Seguros', notes: 'Planilha: Seguro Alfa' });
    expect((await run(rec.id)).skipped).toBe(false);
    expect(rowById('transaction', tx.id).recurringTransactionId).toBeNull();
  });

  it('adopts under the recurrence lock, before linking anything', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Seguro Alfa', amount: 90, nextRunAt: '2026-10-05' });
    imported({ description: 'Seguro Alfa' });
    fakePrisma.$executeRaw.mockClear();
    await run(rec.id);
    expect(String(fakePrisma.$executeRaw.mock.calls[0]![1])).toBe(`recurring:${rec.id}`);
    expect(fakePrisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(fakePrisma.transaction.updateMany.mock.invocationCallOrder[0]!);
  });

  it('the link is conditional: a row somebody linked meanwhile is not taken, the next candidate is', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Seguro Alfa', amount: 90, nextRunAt: '2026-10-05' });
    const rival = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Rival', amount: 1, nextRunAt: '2026-12-01' });
    const a = imported({ description: 'Seguro Alfa', sourceRef: 'ofx:a', date: '2026-10-02' });
    const b = imported({ description: 'Seguro Alfa', sourceRef: 'ofx:b', date: '2026-10-09' });
    const real = fakePrisma.transaction.updateMany.getMockImplementation()!;
    fakePrisma.transaction.updateMany.mockImplementationOnce(async (args: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
      rowById('transaction', a.id).recurringTransactionId = rival.id; // another writer wins the race
      return real(args);
    });
    const result = await run(rec.id);
    expect(result.skipped).toBe(true);
    expect(rowById('transaction', a.id).recurringTransactionId).toBe(rival.id);
    expect(rowById('transaction', b.id).recurringTransactionId).toBe(rec.id);
    expect(linked(rec.id)).toHaveLength(1);
  });

  it('does not change non-monthly recurrences', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Feira', amount: 40, nextRunAt: '2026-10-12', frequency: 'WEEKLY' });
    const tx = imported({ description: 'Feira' });
    const result = await run(rec.id, new Date(2026, 9, 12));
    expect(result.skipped).toBe(false);
    expect(rowById('transaction', tx.id).recurringTransactionId).toBeNull();
  });
});

describe('executeRecurringTransaction recognizes the occurrence already entered by another path', () => {
  // The reported case: a monthly card recurrence due on the 24th whose charge was captured from the bank notification on
  // the 23rd and confirmed. Invented names and amounts.
  const card = () => seedAccount({ id: 'acc-card', householdId: HH, name: 'Cartao Teste', type: 'CREDIT', balance: 0 });
  const due = new Date(2026, 10, 18);

  it('links the confirmed capture of the day before instead of creating a second charge', async () => {
    card();
    const rec = seedRecurrence({ householdId: HH, accountId: 'acc-card', description: 'Seguro Beta', amount: 118.47, nextRunAt: '2026-11-18', aliases: ['Pg *Betaseg Digital'] });
    const capture = imported({ accountId: 'acc-card', description: 'Pg *Betaseg Digital', amount: 118.47, date: '2026-11-17', sourceRef: 'notif:abc' });
    const result = await run(rec.id, due);
    expect(result.skipped).toBe(true);
    expect(rowsOf('transaction')).toHaveLength(1);
    expect(rowById('transaction', capture.id).recurringTransactionId).toBe(rec.id);
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ nextRunAt: '2026-12-18', lastRunDate: '2026-11-18' });
  });

  it('recognizes a capture whose name only resembles the alias when the amount is close', async () => {
    card();
    const rec = seedRecurrence({ householdId: HH, accountId: 'acc-card', description: 'Seguro Beta', amount: 118.47, nextRunAt: '2026-11-18', aliases: ['Pg *Betaseg Digital'], followLastAmount: true });
    const capture = imported({ accountId: 'acc-card', description: 'BETASEG DIGITAL', amount: 121.7, date: '2026-11-17', sourceRef: 'notif:abc' });
    const result = await run(rec.id, due);
    expect(result.skipped).toBe(true);
    expect(rowsOf('transaction')).toHaveLength(1);
    expect(rowById('transaction', capture.id)).toMatchObject({ recurringTransactionId: rec.id, amount: 121.7, description: 'BETASEG DIGITAL' });
  });

  it('a resembling name with a distant amount is not the occurrence: it is created', async () => {
    card();
    const rec = seedRecurrence({ householdId: HH, accountId: 'acc-card', description: 'Seguro Beta', amount: 118.47, nextRunAt: '2026-11-18', aliases: ['Pg *Betaseg Digital'] });
    const other = imported({ accountId: 'acc-card', description: 'Betaseg Digital', amount: 250, date: '2026-11-17', sourceRef: 'notif:abc' });
    const result = await run(rec.id, due);
    expect(result.skipped).toBe(false);
    expect(rowsOf('transaction')).toHaveLength(2);
    expect(rowById('transaction', other.id).recurringTransactionId).toBeNull();
  });

  it.each([
    ['confirmed capture', 'notif:abc'],
    ['card statement OFX', 'ofx:FIT-9'],
    ['sheet row', 'maxfin:2026-11:7'],
    ['hand-typed', null],
  ])('adopts the charge of the day before whatever its origin: %s', async (_label, sourceRef) => {
    card();
    const rec = seedRecurrence({ householdId: HH, accountId: 'acc-card', description: 'Seguro Beta', amount: 118.47, nextRunAt: '2026-11-18', aliases: ['Pg *Betaseg Digital'] });
    const row = imported({ accountId: 'acc-card', description: 'Pg *Betaseg Digital', amount: 118.47, date: '2026-11-17', sourceRef });
    const result = await run(rec.id, due);
    expect(result.skipped).toBe(true);
    expect(rowsOf('transaction')).toHaveLength(1);
    expect(rowById('transaction', row.id).recurringTransactionId).toBe(rec.id);
  });

  it('adopts a hand-typed row with the recurrence name', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Seguro Alfa', amount: 90, nextRunAt: '2026-10-05' });
    const typed = imported({ description: 'Seguro Alfa', sourceRef: null, amount: 90 });
    const result = await run(rec.id);
    expect(result.skipped).toBe(true);
    expect(rowsOf('transaction')).toHaveLength(1);
    expect(rowById('transaction', typed.id).recurringTransactionId).toBe(rec.id);
  });

  it('adopts a charge entered up to 7 days before the due day, even in the previous month', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Seguro Alfa', amount: 90, nextRunAt: '2026-11-03' });
    const early = imported({ description: 'Seguro Alfa', sourceRef: 'ofx:early', date: '2026-10-28' });
    const result = await run(rec.id, new Date(2026, 10, 3));
    expect(result.skipped).toBe(true);
    expect(rowById('transaction', early.id).recurringTransactionId).toBe(rec.id);
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ nextRunAt: '2026-12-03' });
  });

  it('does not take the charge of another recurrence with a resembling name', async () => {
    card();
    const rec = seedRecurrence({ householdId: HH, accountId: 'acc-card', description: 'Seguro Beta', amount: 130, nextRunAt: '2026-11-18', aliases: ['Betaseg'] });
    seedRecurrence({ householdId: HH, accountId: 'acc-card', description: 'Betaseg Residencial', amount: 130, nextRunAt: '2026-12-20' });
    const theirs = imported({ accountId: 'acc-card', description: 'Betaseg Residencial', amount: 130, date: '2026-11-22', sourceRef: 'notif:x' });
    const result = await run(rec.id, due);
    expect(result.skipped).toBe(false);
    expect(rowById('transaction', theirs.id).recurringTransactionId).toBeNull();
  });

  it('nothing entered: the occurrence is created as before', async () => {
    card();
    const rec = seedRecurrence({ householdId: HH, accountId: 'acc-card', description: 'Seguro Beta', amount: 118.47, nextRunAt: '2026-11-18', aliases: ['Pg *Betaseg Digital'] });
    imported({ accountId: 'acc-card', description: 'Padaria Gama', amount: 118.47, date: '2026-11-17', sourceRef: 'notif:p' });
    const result = await run(rec.id, due);
    expect(result.skipped).toBe(false);
    expect(linked(rec.id)).toHaveLength(1);
    expect(linked(rec.id)[0]).toMatchObject({ description: 'Seguro Beta', date: '2026-11-18' });
  });
});
