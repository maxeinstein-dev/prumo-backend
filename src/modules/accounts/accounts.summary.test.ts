import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';

const db = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock('../../shared/db/prisma.js', () => ({ prisma: { account: { findMany: db.findMany } } }));

const { getAccountsSummary } = await import('./accounts.service.js');

const row = (type: string, currency: string, balance: string) => ({ type, currency, balance: new Prisma.Decimal(balance) });

beforeEach(() => vi.clearAllMocks());

describe('getAccountsSummary', () => {
  it('sums balances to the exact cent (0.1 + 0.2 is 0.3, not 0.30000000000000004)', async () => {
    db.findMany.mockResolvedValue([row('CHECKING', 'BRL', '0.10'), row('CHECKING', 'BRL', '0.20'), row('SAVINGS', 'BRL', '0.30')]);
    const summary = await getAccountsSummary('h1');
    expect(summary.byType.CHECKING).toEqual({ count: 2, total: 0.3 });
    expect(summary.byType.SAVINGS).toEqual({ count: 1, total: 0.3 });
    expect(summary.byCurrency.BRL).toBe(0.6);
    expect(summary.totalAccounts).toBe(3);
  });

  it('keeps negative balances and separate currencies', async () => {
    db.findMany.mockResolvedValue([row('CREDIT', 'BRL', '-10.05'), row('CHECKING', 'USD', '3.10')]);
    const summary = await getAccountsSummary('h1');
    expect(summary.byType.CREDIT).toEqual({ count: 1, total: -10.05 });
    expect(summary.byCurrency).toEqual({ BRL: -10.05, USD: 3.1 });
  });
});
