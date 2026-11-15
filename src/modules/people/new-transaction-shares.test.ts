import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakePrisma, resetStore, rowsOf, seedPerson, seedTransaction, seedAccount } from './__fixtures__/people-fake-db.js';
import { checkNewTransactionSplit, writeNewTransactionSharesInTx } from './shares.service.js';

vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('./__fixtures__/people-fake-db.js')).fakePrisma,
}));

// Invented data only.
const HH = 'hh-1';
let ana: string;
let gone: string;

beforeEach(() => {
  resetStore();
  ana = seedPerson({ householdId: HH, name: 'Ana Teste' }).id;
  gone = seedPerson({ householdId: HH, name: 'Pessoa Inativa', isActive: false }).id;
  seedPerson({ householdId: 'hh-2', name: 'Outra Casa' });
});

const db = fakePrisma as never;

describe('split sent together with a new transaction (P19 L3)', () => {
  it('"Metade com": equal with one person gives half (the odd cent stays with the person, as in PUT shares)', async () => {
    const parts = await checkNewTransactionSplit(db, HH, { type: 'EXPENSE', amountCents: 4501 }, { strategy: 'equal', entries: [{ personId: ana }] });
    expect(parts).toEqual([expect.objectContaining({ personId: ana, amountCents: 2251 })]);
  });

  it('"É de": 100% hands out the whole amount', async () => {
    const parts = await checkNewTransactionSplit(db, HH, { type: 'EXPENSE', amountCents: 20899 }, { strategy: 'percent', entries: [{ personId: ana, percent: 100 }] });
    expect(parts).toEqual([expect.objectContaining({ personId: ana, amountCents: 20899 })]);
  });

  it('refuses an income, an inactive person, a person of another household and parts above the amount', async () => {
    await expect(checkNewTransactionSplit(db, HH, { type: 'INCOME', amountCents: 1000 }, { strategy: 'equal', entries: [{ personId: ana }] })).rejects.toThrow(/expense/);
    await expect(checkNewTransactionSplit(db, HH, { type: 'EXPENSE', amountCents: 1000 }, { strategy: 'equal', entries: [{ personId: gone }] })).rejects.toThrow(/inactive/);
    const other = rowsOf('person').find((p) => p.householdId === 'hh-2')!.id;
    await expect(checkNewTransactionSplit(db, HH, { type: 'EXPENSE', amountCents: 1000 }, { strategy: 'equal', entries: [{ personId: other }] })).rejects.toThrow(/Person/);
    await expect(checkNewTransactionSplit(db, HH, { type: 'EXPENSE', amountCents: 1000 }, { strategy: 'exact', entries: [{ personId: ana, amount: 10.01 }] })).rejects.toThrow(/more than/);
  });

  it('writes the parts as shares the person owes me', async () => {
    seedAccount({ householdId: HH });
    const tx = seedTransaction({ householdId: HH, amount: 45.01, type: 'EXPENSE', date: '2026-12-01' } as never);
    await writeNewTransactionSharesInTx(db, HH, tx.id, { type: 'EXPENSE', amountCents: 4501 }, { strategy: 'equal', entries: [{ personId: ana }] });
    expect(rowsOf('transactionShare')).toEqual([
      expect.objectContaining({ householdId: HH, transactionId: tx.id, personId: ana, amount: 22.51, direction: 'THEY_OWE_ME', source: 'manual' }),
    ]);
  });
});
