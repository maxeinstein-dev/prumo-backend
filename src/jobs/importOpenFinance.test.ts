import { describe, expect, it, vi } from 'vitest';

vi.mock('../shared/db/prisma.js', () => ({ prisma: {} }));

import { OpenFinanceJobError, runOpenFinanceJob } from './importOpenFinance.js';

// Invented ids only.
const HH_A = '11111111-1111-4111-8111-111111111111';
const HH_B = '22222222-2222-4222-8222-222222222222';
const ok = { refs: 1, drafts: 2, transferDrafts: 0, yieldDrafts: 0, blocked: [] };

function fakeDb(households: string[]) {
  return { openFinanceLink: { findMany: vi.fn(async () => households.map((householdId) => ({ householdId }))) } };
}

describe('runOpenFinanceJob', () => {
  it('imports every household with a linked account, one after the other, and sums the results', async () => {
    const db = fakeDb([HH_A, HH_B]);
    const runImport = vi.fn(async () => ok);

    const summary = await runOpenFinanceJob({ db: db as never, runImport });

    expect(db.openFinanceLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { pluggyAccountId: { not: null }, accountId: { not: null } }, distinct: ['householdId'] }),
    );
    expect(runImport.mock.calls.map((c) => (c as unknown as [{ householdId: string }])[0].householdId)).toEqual([HH_A, HH_B]);
    expect(summary).toEqual({ households: 2, refs: 2, drafts: 4, transferDrafts: 0, yieldDrafts: 0, blocked: [] });
  });

  it('with nothing linked it does nothing', async () => {
    const runImport = vi.fn();
    expect(await runOpenFinanceJob({ db: fakeDb([]) as never, runImport })).toEqual({ households: 0, refs: 0, drafts: 0, transferDrafts: 0, yieldDrafts: 0, blocked: [] });
    expect(runImport).not.toHaveBeenCalled();
  });

  it('a blocked bank fails the run after every household was imported, saying which connection to renew', async () => {
    const runImport = vi
      .fn()
      .mockResolvedValueOnce({ ...ok, blocked: [{ itemId: 'aaaaaaaa-0000-4000-8000-00000000000a', reason: 'A autorização deste banco venceu: reconecte no Meu Pluggy.' }] })
      .mockResolvedValueOnce(ok);

    const error = await runOpenFinanceJob({ db: fakeDb([HH_A, HH_B]) as never, runImport }).catch((e: unknown) => e);

    expect(runImport).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(OpenFinanceJobError);
    expect((error as Error).message).toContain('aaaaaaaa');
    expect((error as Error).message).toContain('reconecte no Meu Pluggy');
  });

  it('a household that fails does not stop the others, and the run fails at the end', async () => {
    const runImport = vi.fn().mockRejectedValueOnce(new Error('Pluggy could not be reached')).mockResolvedValueOnce(ok);

    const error = await runOpenFinanceJob({ db: fakeDb([HH_A, HH_B]) as never, runImport }).catch((e: unknown) => e);

    expect(runImport).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(OpenFinanceJobError);
    expect((error as Error).message).toContain('Pluggy could not be reached');
  });
});
