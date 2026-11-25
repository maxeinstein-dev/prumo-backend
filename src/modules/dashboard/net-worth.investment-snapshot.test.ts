import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P21 L4: the net worth reads the daily picture that the investments module writes. One in-memory fake plays the whole
// path: recordAccountSnapshots writes account_valuations, loadNetWorth reads it back, listPositions gives the total.
const store = vi.hoisted(() => ({ valuations: [] as Array<{ accountId: string; date: Date; amount: { toNumber(): number; toString(): string } }> }));
const db = vi.hoisted(() => {
  const d: Record<string, any> = {
    account: { findMany: vi.fn(), findUnique: vi.fn() },
    investmentPosition: { findMany: vi.fn() },
    investmentMovement: { findMany: vi.fn() },
    assetQuote: { findMany: vi.fn() },
    indexRate: { findMany: vi.fn() },
    accountValuation: { findMany: vi.fn(), upsert: vi.fn() },
    transaction: { findMany: vi.fn() },
    employment: { findMany: vi.fn() },
  };
  return d;
});
vi.mock('../../shared/db/prisma.js', () => ({ prisma: db }));

import { listPositions, loadAccount } from '../investments/investments.service.js';
import { recordAccountSnapshots } from '../investments/investments.snapshot.js';
import { loadNetWorth } from './net-worth.loader.js';

// Invented data only.
const HH = '00000000-0000-4000-8000-0000000000f0';
const BRK = '00000000-0000-4000-8000-000000000001';
const OLD = '00000000-0000-4000-8000-000000000002'; // an investment account with a typed value only, no positions
const STOCK = '00000000-0000-4000-8000-000000000010';
const CDB = '00000000-0000-4000-8000-000000000011';
const dec = (n: number) => ({ toNumber: () => n, toString: () => String(n) });
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const TODAY = '2026-11-09'; // a Monday

const accountRow = (id: string, name: string, balance: number) => ({ id, householdId: HH, name, type: 'INVESTMENT', isActive: true, balance: dec(balance), currency: 'BRL', createdAt: new Date('2026-01-01T00:00:00Z') });
const base = { householdId: HH, accountId: BRK, savingsGoalId: null, maturityDate: null, anchorAmount: null, anchorDate: null, closedAt: null, createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z') };
const stock = { ...base, id: STOCK, kind: 'STOCK_EXCHANGE', ticker: 'TEST11', name: 'Fundo Exemplo', indexer: null, rate: null };
const cdb = { ...base, id: CDB, kind: 'FIXED_INCOME', ticker: null, name: 'CDB Exemplo', indexer: 'CDI', rate: dec(100) };
let n = 0;
const movement = (positionId: string, type: string, date: string, quantity: number | null, amount: number) => ({
  id: `00000000-0000-4000-8000-0000000002${String(++n).padStart(2, '0')}`, householdId: HH, positionId, type, date: day(date),
  quantity: quantity === null ? null : dec(quantity), unitPrice: quantity === null ? null : dec(amount / quantity),
  amount: dec(amount), notes: null, sourceRef: null, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  store.valuations = [
    // values typed by hand in the past, in both accounts: the old way (P04)
    { accountId: BRK, date: day('2026-09-30'), amount: dec(900) },
    { accountId: BRK, date: day('2026-10-31'), amount: dec(950) },
    { accountId: OLD, date: day('2026-10-31'), amount: dec(300) },
  ];
  const accounts = [accountRow(BRK, 'Corretora Exemplo', 1000), accountRow(OLD, 'Banco Exemplo', 300)];
  db.account.findMany.mockResolvedValue(accounts);
  db.account.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => accounts.find((a) => a.id === where.id) ?? null);
  db.investmentPosition.findMany.mockImplementation(async (args: { distinct?: string[] }) => (args?.distinct ? [{ accountId: BRK }] : [stock, cdb]));
  db.investmentMovement.findMany.mockResolvedValue([
    movement(STOCK, 'OPENING', '2026-10-01', 10, 100),
    movement(STOCK, 'BUY', '2026-11-03', 1, 11),
    movement(STOCK, 'INCOME', '2026-11-04', null, 8.5),
    movement(CDB, 'OPENING', '2026-11-02', null, 500),
  ]);
  db.assetQuote.findMany.mockResolvedValue([{ ticker: 'TEST11', date: day('2026-11-06'), close: dec(12.34) }]);
  db.indexRate.findMany.mockResolvedValue(['02', '03', '04', '05', '06'].map((d) => ({ index: 'CDI', date: day(`2026-11-${d}`), value: dec(0.05) })));
  db.accountValuation.findMany.mockImplementation(async () => [...store.valuations].sort((a, b) => a.date.getTime() - b.date.getTime()));
  db.accountValuation.upsert.mockImplementation(async ({ where, create, update }: { where: { accountId_date: { accountId: string; date: Date } }; create: { accountId: string; date: Date; amount: any }; update: { amount: any } }) => {
    const k = where.accountId_date;
    const i = store.valuations.findIndex((v) => v.accountId === k.accountId && v.date.getTime() === k.date.getTime());
    if (i >= 0) store.valuations[i] = { ...store.valuations[i]!, amount: update.amount };
    else store.valuations.push(create);
  });
  db.transaction.findMany.mockResolvedValue([]);
  db.employment.findMany.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

const worth = () => loadNetWorth({ householdId: HH, months: 4, today: new Date(`${TODAY}T00:00:00Z`) });
const investmentLine = (w: Awaited<ReturnType<typeof worth>>, id: string) => w.composition.find((c) => c.kind === 'investment' && c.id === id)!;

describe('net worth and the daily picture of an investment account', () => {
  it('on the day of the picture, the account in the net worth equals the total of the account summary, to the cent', async () => {
    const { summary } = await listPositions((await loadAccount(BRK)) as never, { asOf: TODAY });
    // stock 11 x 12,34 = 135,74; cdb 500 x 1,0005^5 = 501,25; cash 1000 - 11 + 8,5 = 997,5
    expect(summary.totalValue).toBe(1634.49);

    const r = await recordAccountSnapshots(TODAY);
    expect(r.recorded).toEqual([{ accountId: BRK, totalCents: 163449 }]);

    const w = await worth();
    expect(investmentLine(w, BRK).amount).toBe(summary.totalValue);
    expect(investmentLine(w, BRK).amount).toBe(1634.49);
    // the month column of the current month carries the same two accounts: picture + the typed one
    expect(w.months[w.months.length - 1]!.investments).toBe(1634.49 + 300);
  });

  it('months before the picture, with typed values, do not change', async () => {
    const before = await worth();
    await recordAccountSnapshots(TODAY);
    const after = await worth();
    const past = (w: typeof before) => w.months.filter((m) => m.month < '2026-11').map((m) => [m.month, m.investments, m.total]);
    expect(past(after)).toEqual(past(before));
    // and those values are the typed ones (Sep 900 + the other account's older fallback; Oct 950 + 300)
    const oct = after.months.find((m) => m.month === '2026-10')!;
    expect(oct.investments).toBe(950 + 300);
    expect(db.accountValuation.upsert).toHaveBeenCalledTimes(1); // only the row of the day was written
  });

  it('an investment account with no position keeps its typed value: the picture never touches it', async () => {
    await recordAccountSnapshots(TODAY);
    const w = await worth();
    expect(investmentLine(w, OLD).amount).toBe(300);
    expect(store.valuations.filter((v) => v.accountId === OLD)).toHaveLength(1);
  });
});
