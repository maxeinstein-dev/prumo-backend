import { describe, expect, it, vi } from 'vitest';

import { runPluggySecretCheck, secretReminderStage, type SecretCheckDb } from './secret-reminder.js';

// Invented ids and keys only.
const HH_1 = '11111111-1111-4111-8111-111111111111';
const HH_2 = '22222222-2222-4222-8222-222222222222';
const USER_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const USER_B = 'bbbbbbbb-1111-4111-8111-111111111111';
const KEYS = { PLUGGY_CLIENT_ID: 'cid-inventado', PLUGGY_CLIENT_SECRET: 'pluggy_sk_inventado_nunca_aparece' };

function fakeDb(options: { existing?: boolean; households?: string[]; members?: string[] } = {}) {
  const created: Array<{ data: Record<string, unknown> }> = [];
  const db = {
    openFinanceLink: { findMany: vi.fn(async () => (options.households ?? [HH_1, HH_2]).map((householdId) => ({ householdId }))) },
    householdMember: { findMany: vi.fn(async () => (options.members ?? [USER_A, USER_B, USER_A]).map((userId) => ({ userId }))) },
    notification: {
      findFirst: vi.fn(async () => (options.existing ? { id: 'n-1' } : null)),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        created.push(args);
        return { id: `n-${created.length}` };
      }),
    },
  };
  return { db: db as unknown as SecretCheckDb, raw: db, created };
}

describe('secretReminderStage', () => {
  it('expires 180 days after the secret was made and warns from 30 days before, again at 7 and once expired', () => {
    expect(secretReminderStage('2026-11-26', '2026-11-26')).toEqual({ expiresOn: '2027-05-25', daysLeft: 180, stage: null });
    expect(secretReminderStage('2026-11-26', '2027-04-24')).toMatchObject({ daysLeft: 31, stage: null });
    expect(secretReminderStage('2026-11-26', '2027-04-25')).toMatchObject({ daysLeft: 30, stage: '30d' });
    expect(secretReminderStage('2026-11-26', '2027-05-18')).toMatchObject({ daysLeft: 7, stage: '7d' });
    expect(secretReminderStage('2026-11-26', '2027-05-25')).toMatchObject({ daysLeft: 0, stage: 'expired' });
    expect(secretReminderStage('2026-11-26', '2027-06-10')).toMatchObject({ daysLeft: -16, stage: 'expired' });
  });
});

describe('runPluggySecretCheck', () => {
  it('without keys and without date: Open Finance is off, nothing is checked or written', async () => {
    const { db, raw } = fakeDb();
    const checkCredentials = vi.fn();

    const result = await runPluggySecretCheck({ env: {}, today: '2027-05-20', db, checkCredentials });

    expect(result).toEqual({ status: 'not_configured', notified: 0 });
    expect(checkCredentials).not.toHaveBeenCalled();
    expect(raw.notification.create).not.toHaveBeenCalled();
  });

  it('keys without PLUGGY_SECRET_CREATED_AT (or with a bad date) fail the run instead of never warning', async () => {
    const { db } = fakeDb();
    const checkCredentials = vi.fn(async () => 'ok' as const);

    await expect(runPluggySecretCheck({ env: KEYS, today: '2027-01-01', db, checkCredentials })).rejects.toThrow(
      /PLUGGY_SECRET_CREATED_AT/,
    );
    await expect(
      runPluggySecretCheck({ env: { ...KEYS, PLUGGY_SECRET_CREATED_AT: '26/11/2026' }, today: '2027-01-01', db, checkCredentials }),
    ).rejects.toThrow(/PLUGGY_SECRET_CREATED_AT/);
  });

  it('far from the date and keys accepted: ok, nothing written', async () => {
    const { db, raw } = fakeDb();

    const result = await runPluggySecretCheck({
      env: { ...KEYS, PLUGGY_SECRET_CREATED_AT: '2026-11-26' },
      today: '2027-01-10',
      db,
      checkCredentials: async () => 'ok',
    });

    expect(result).toEqual({ status: 'ok', expiresOn: '2027-05-25', daysLeft: 135, notified: 0 });
    expect(raw.notification.create).not.toHaveBeenCalled();
  });

  it('30 days before: one notification per member of the households with Open Finance, without the secret', async () => {
    const { db, raw, created } = fakeDb();

    const result = await runPluggySecretCheck({
      env: { ...KEYS, PLUGGY_SECRET_CREATED_AT: '2026-11-26' },
      today: '2027-04-25',
      db,
      checkCredentials: async () => 'ok',
    });

    expect(result).toEqual({ status: 'due', expiresOn: '2027-05-25', daysLeft: 30, stage: '30d', notified: 2 });
    expect(raw.householdMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { householdId: { in: [HH_1, HH_2] } } }),
    );
    expect(created.map((c) => c.data.userId)).toEqual([USER_A, USER_B]);
    const data = created[0].data;
    expect(data.type).toBe('SYSTEM_ALERT');
    expect(data.title).toBe('Renove o segredo da Pluggy');
    expect(data.message).toContain('25/05/2027');
    expect(data.message).toContain('30 dias');
    expect(data.metadata).toEqual({ kind: 'pluggy-secret', reminderKey: 'pluggy-secret:2027-05-25:30d', expiresOn: '2027-05-25' });
    expect(JSON.stringify(created)).not.toContain(KEYS.PLUGGY_CLIENT_SECRET);
  });

  it('the same stage on the next day writes nothing again (no daily repeats)', async () => {
    const { db, raw } = fakeDb({ existing: true });

    const result = await runPluggySecretCheck({
      env: { ...KEYS, PLUGGY_SECRET_CREATED_AT: '2026-11-26' },
      today: '2027-04-26',
      db,
      checkCredentials: async () => 'ok',
    });

    expect(result).toMatchObject({ status: 'due', stage: '30d', notified: 0 });
    expect(raw.notification.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_A, metadata: { path: ['reminderKey'], equals: 'pluggy-secret:2027-05-25:30d' } },
      }),
    );
    expect(raw.notification.create).not.toHaveBeenCalled();
  });

  it('keys refused by Pluggy before the date: warns as refused (once per secret)', async () => {
    const { db, created } = fakeDb({ households: [HH_1], members: [USER_A] });

    const result = await runPluggySecretCheck({
      env: { ...KEYS, PLUGGY_SECRET_CREATED_AT: '2026-11-26' },
      today: '2027-01-10',
      db,
      checkCredentials: async () => 'refused',
    });

    expect(result).toMatchObject({ status: 'refused', stage: 'refused', notified: 1 });
    expect(created[0].data.title).toBe('A Pluggy recusou o segredo');
    expect(created[0].data.metadata).toMatchObject({ reminderKey: 'pluggy-secret:2027-05-25:refused' });
  });

  it('no household with Open Finance: reports the stage but writes no notification (and so the workflow does not e-mail)', async () => {
    const { db, raw } = fakeDb({ households: [] });

    const result = await runPluggySecretCheck({
      env: { ...KEYS, PLUGGY_SECRET_CREATED_AT: '2026-11-26' },
      today: '2027-05-20',
      db,
      checkCredentials: async () => 'ok',
    });

    expect(result).toMatchObject({ status: 'due', stage: '7d', notified: 0 });
    expect(raw.householdMember.findMany).not.toHaveBeenCalled();
  });
});
