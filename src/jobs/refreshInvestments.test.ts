import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.hoisted(() => ({ runInvestmentRefresh: vi.fn() }));
const study = vi.hoisted(() => ({ purgeStudyCaptures: vi.fn() }));
vi.mock('../modules/captures/captures.xp.js', () => ({ purgeStudyCaptures: study.purgeStudyCaptures }));
vi.mock('../shared/config/env.js', () => ({ env: {} }));
vi.mock('../shared/db/prisma.js', () => ({ prisma: { $disconnect: vi.fn() } }));
vi.mock('../modules/investments/investments.refresh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../modules/investments/investments.refresh.js')>()),
  runInvestmentRefresh: refresh.runInvestmentRefresh,
}));

import { InvestmentRefreshError } from '../modules/investments/investments.refresh.js';
import { runInvestmentsJob } from './refreshInvestments.js';

const TOKEN = 'tok-invented-987654';
let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  study.purgeStudyCaptures.mockResolvedValue(0);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('refreshInvestments job', () => {
  it('stale market data fails the run after everything else was done, so the workflow opens its issue', async () => {
    refresh.runInvestmentRefresh.mockResolvedValue({
      quotesSaved: 0, ratesSaved: 0, snapshots: [{ accountId: 'a', totalCents: 5 }], warnings: ['No usable price'],
      stale: { staleTickers: 3, staleIndexes: [] },
    });
    await expect(runInvestmentsJob({ today: '2026-11-25', env: {} })).rejects.toThrow(/3 ticker/);
    expect(log.mock.calls.flat().join(' ')).toMatch(/snapshots recorded: 1/i);
  });

  it('fresh market data keeps the run green', async () => {
    refresh.runInvestmentRefresh.mockResolvedValue({ quotesSaved: 3, ratesSaved: 1, snapshots: [], warnings: [], stale: { staleTickers: 0, staleIndexes: [] } });
    await expect(runInvestmentsJob({ today: '2026-11-25', env: {} })).resolves.toBeDefined();
  });

  it('fetch warnings are printed as warnings and the run still ends well', async () => {
    refresh.runInvestmentRefresh.mockResolvedValue({ quotesSaved: 0, ratesSaved: 0, snapshots: [], warnings: ['brapi unavailable (timeout): quotes not updated'] });
    await expect(runInvestmentsJob({ today: '2026-11-25', env: { BRAPI_TOKEN: TOKEN } })).resolves.toBeDefined();
    expect(warn.mock.calls.flat().join(' ')).toContain('brapi unavailable (timeout)');
  });

  it('a snapshot failure fails the run (the process will exit with an error)', async () => {
    refresh.runInvestmentRefresh.mockRejectedValue(new InvestmentRefreshError(['acc-1']));
    await expect(runInvestmentsJob({ today: '2026-11-25', env: {} })).rejects.toBeInstanceOf(InvestmentRefreshError);
  });

  it('builds the brapi client with the token of the environment and never prints it', async () => {
    refresh.runInvestmentRefresh.mockResolvedValue({ quotesSaved: 1, ratesSaved: 2, snapshots: [{ accountId: 'a', totalCents: 5 }], warnings: [] });
    await runInvestmentsJob({ today: '2026-11-25', env: { BRAPI_TOKEN: TOKEN } });
    expect(refresh.runInvestmentRefresh).toHaveBeenCalledWith(expect.objectContaining({ today: '2026-11-25', brapi: expect.anything(), bcb: expect.anything() }));
    const printed = [...log.mock.calls, ...warn.mock.calls].flat().join(' ');
    expect(printed).not.toContain(TOKEN);
    expect(printed).toMatch(/quotes saved: 1/i);
  });

  it('prints no amounts or names: only counts', async () => {
    refresh.runInvestmentRefresh.mockResolvedValue({ quotesSaved: 1, ratesSaved: 2, snapshots: [{ accountId: 'a', totalCents: 123456 }], warnings: [] });
    await runInvestmentsJob({ today: '2026-11-25', env: {} });
    expect([...log.mock.calls].flat().join(' ')).not.toContain('123456');
  });

  it('also deletes the XP captures in study that are past their 60 days, and prints only the count', async () => {
    refresh.runInvestmentRefresh.mockResolvedValue({ quotesSaved: 0, ratesSaved: 0, snapshots: [], warnings: [] });
    study.purgeStudyCaptures.mockResolvedValue(3);
    await runInvestmentsJob({ today: '2026-11-25', env: {} });
    expect(study.purgeStudyCaptures).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join(' ')).toMatch(/study captures deleted: 3/i);
  });

  it('a failed deletion does not stop the quotes and snapshots, but fails the run', async () => {
    refresh.runInvestmentRefresh.mockResolvedValue({ quotesSaved: 1, ratesSaved: 0, snapshots: [], warnings: [] });
    study.purgeStudyCaptures.mockRejectedValue(new Error('db down'));
    await expect(runInvestmentsJob({ today: '2026-11-25', env: {} })).rejects.toThrow('db down');
    expect(refresh.runInvestmentRefresh).toHaveBeenCalledTimes(1);
  });
});
