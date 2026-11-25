import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

// An in-memory stand-in for the tables the XP flow touches. It has NO `transaction` model and NO `account.update`:
// a path that tried to create a lançamento or move a balance would throw ("never count twice", P21 risk 1).
// `$transaction` runs one callback at a time (a row lock, like Postgres) and rolls the rows back when it throws.
const db = vi.hoisted(() => {
  const s = {
    captures: [] as Row[],
    positions: [] as Row[],
    movements: [] as Row[],
    quotes: [] as Row[],
    accounts: [] as Row[],
    goals: [] as Row[],
    seq: 0,
    lock: Promise.resolve() as Promise<unknown>,
  };
  const id = (prefix: string) => `${prefix}-${String(++s.seq).padStart(4, '0')}`;
  const time = (v: unknown) => (v instanceof Date ? v.getTime() : NaN);
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (key === 'OR') return (cond as Row[]).some((alt) => matches(row, alt));
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        if ('in' in cond) return (cond.in as unknown[]).includes(row[key]);
        if ('lt' in cond && cond.lt instanceof Date) return time(row[key]) < cond.lt.getTime();
        if ('lt' in cond) return typeof row[key] === 'number' && row[key] < cond.lt;
        if ('gte' in cond || 'lte' in cond) {
          const v = time(row[key]);
          return (!cond.gte || v >= cond.gte.getTime()) && (!cond.lte || v <= cond.lte.getTime());
        }
        return false;
      }
      return (row[key] ?? null) === cond;
    });
  const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row });

  const prisma: Record<string, any> = {
    capturedNotification: {
      findFirst: vi.fn(async ({ where, select }: Row) => {
        const r = s.captures.find((c) => matches(c, where));
        return r ? pick(r, select) : null;
      }),
      findMany: vi.fn(async ({ where, select, take }: Row) => {
        const rows = s.captures
          .filter((c) => matches(c, where))
          .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime() || String(b.id).localeCompare(String(a.id)));
        return rows.slice(0, take ?? rows.length).map((r) => pick(r, select));
      }),
      count: vi.fn(async ({ where }: Row) => s.captures.filter((c) => matches(c, where)).length),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const rows = s.captures.filter((c) => matches(c, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      }),
      deleteMany: vi.fn(async ({ where }: Row) => {
        const before = s.captures.length;
        s.captures = s.captures.filter((c) => !matches(c, where));
        return { count: before - s.captures.length };
      }),
      createManyAndReturn: vi.fn(async ({ data }: Row) => {
        const made: Row[] = [];
        for (const d of data as Row[]) {
          if (s.captures.some((c) => c.householdId === d.householdId && c.dedupKey === d.dedupKey)) continue;
          const row = { id: id('cap'), transactionId: null, createdAt: new Date(), ...d };
          s.captures.push(row);
          made.push({ dedupKey: row.dedupKey });
        }
        return made;
      }),
    },
    captureAccountRule: { findMany: vi.fn(async () => []) },
    captureCardRule: { findMany: vi.fn(async () => []) },
    transaction: undefined,
    account: { findUnique: vi.fn(async ({ where }: Row) => s.accounts.find((a) => a.id === where.id) ?? null) },
    savingsGoal: { findFirst: vi.fn(async ({ where }: Row) => s.goals.find((g) => matches(g, where)) ?? null) },
    investmentPosition: {
      findUnique: vi.fn(async ({ where, include }: Row) => {
        const p = s.positions.find((x) => x.id === where.id);
        return p ? { ...p, ...(include?.account ? { account: s.accounts.find((a) => a.id === p.accountId) } : {}) } : null;
      }),
      findFirst: vi.fn(async ({ where }: Row) => s.positions.find((p) => matches(p, where)) ?? null),
      findMany: vi.fn(async ({ where }: Row) => s.positions.filter((p) => matches(p, where))),
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: id('pos'), closedAt: null, createdAt: new Date(), ...data };
        s.positions.push(row);
        return row;
      }),
    },
    investmentMovement: {
      findMany: vi.fn(async ({ where }: Row) => s.movements.filter((m) => matches(m, where))),
      findFirst: vi.fn(async ({ where }: Row) => s.movements.find((m) => matches(m, where)) ?? null),
      create: vi.fn(async ({ data }: Row) => {
        if (data.sourceRef && s.movements.some((m) => m.householdId === data.householdId && m.sourceRef === data.sourceRef)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const row = { id: id('mov'), createdAt: new Date(), ...data };
        s.movements.push(row);
        return row;
      }),
    },
    assetQuote: {
      findFirst: vi.fn(async ({ where }: Row) => {
        const rows = s.quotes.filter((q) => q.ticker === where.ticker && time(q.date) <= where.date.lte.getTime()).sort((a, b) => b.date.getTime() - a.date.getTime());
        return rows[0] ?? null;
      }),
    },
    $queryRaw: vi.fn(async () => []),
  };
  prisma.$transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    const run = async () => {
      const snapshot = { captures: s.captures.map((r) => ({ ...r })), positions: s.positions.map((r) => ({ ...r })), movements: s.movements.map((r) => ({ ...r })) };
      try {
        return await cb(prisma);
      } catch (error) {
        Object.assign(s, snapshot);
        throw error;
      }
    };
    const result = s.lock.then(run, run);
    s.lock = result.catch(() => undefined);
    return result;
  });
  return { s, prisma };
});
vi.mock('../../shared/db/prisma.js', () => ({ prisma: db.prisma }));
vi.mock('../../shared/config/env.js', () => ({ env: {}, isLocalAuth: true, isProduction: false }));

import { ConflictError } from '../../shared/errors/index.js';
import { confirmCapture, countCaptures, ingestCaptures, listCaptures, reparseCaptures } from './captures.service.js';
import { confirmInvestmentCapture, listStudyCaptures, purgeStudyCaptures } from './captures.xp.js';

const XP = 'br.com.xp.carteira';
const HH = '00000000-0000-4000-8000-0000000000f0';
const OTHER_HH = '00000000-0000-4000-8000-0000000000f1';
const USER = '00000000-0000-4000-8000-0000000000a1';
const ACC = '00000000-0000-4000-8000-000000000001';
const OTHER_ACC = '00000000-0000-4000-8000-000000000002';
const scope = { householdId: HH, userId: USER };
const DAY_MS = 86_400_000;
const NOW = new Date('2026-11-25T12:00:00.000Z');
const dec = (n: number) => ({ toNumber: () => n, toString: () => String(n) });
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

let n = 0;
function capture(kind: string, over: Row = {}, parsedOver: Row = {}): Row {
  n += 1;
  const reading: Row = {
    XP_INCOME: { kind, type: null, amountCents: 1234, amount: 12.34, description: 'Rendimento TEST11', ticker: 'TEST11' },
    XP_REINVEST_DONE: { kind, type: null, amountCents: 777, amount: 7.77, description: 'Reinvestimento TEST11', ticker: 'TEST11' },
    XP_REINVEST_NOTICE: { kind, type: null, amountCents: 1234, amount: 12.34, description: 'Aviso de reinvestimento TEST11', ticker: 'TEST11', executionDate: '2026-11-24' },
    XP_STUDY: { kind, type: null, amountCents: null, amount: null, description: null },
    CARD_PURCHASE: { kind, type: 'EXPENSE', amountCents: 5000, amount: 50, description: 'LOJA' },
  }[kind]!;
  const status = kind === 'XP_STUDY' ? 'STUDY' : kind === 'XP_REINVEST_NOTICE' ? 'IGNORED' : 'PENDING';
  const row: Row = {
    id: `cap-${String(n).padStart(4, '0')}`,
    householdId: HH,
    userId: USER,
    package: kind === 'CARD_PURCHASE' ? 'com.nu.production' : XP,
    title: 'titulo',
    text: 'texto',
    postedAt: new Date('2026-11-24T21:09:00.000Z'),
    dedupKey: `dedup-${n}`,
    status,
    parsed: { ...reading, ...parsedOver },
    parserVersion: 6,
    transactionId: null,
    createdAt: NOW,
    ...over,
  };
  db.s.captures.push(row);
  return row;
}

function account(over: Row = {}): Row {
  const row = { id: ACC, householdId: HH, name: 'Corretora Exemplo', type: 'INVESTMENT', isActive: true, balance: dec(1000), ...over };
  db.s.accounts.push(row);
  return row;
}
function position(over: Row = {}): Row {
  const row = {
    id: `pos-fix-${db.s.positions.length + 1}`, householdId: HH, accountId: ACC, kind: 'STOCK_EXCHANGE', ticker: 'TEST11', name: 'Fundo Exemplo',
    savingsGoalId: null, indexer: null, rate: null, maturityDate: null, anchorAmount: null, anchorDate: null, closedAt: null, createdAt: new Date('2026-01-01T00:00:00Z'), ...over,
  };
  db.s.positions.push(row);
  return row;
}
const opening = (positionId: string, quantity = 10) =>
  db.s.movements.push({ id: `mov-open-${positionId}`, householdId: HH, positionId, type: 'OPENING', date: day('2026-01-01'), quantity: dec(quantity), unitPrice: dec(10), amount: dec(quantity * 10), notes: null, sourceRef: null, createdAt: new Date('2026-01-01T00:00:00Z') });

beforeEach(() => {
  const s = db.s;
  s.captures = [];
  s.positions = [];
  s.movements = [];
  s.quotes = [];
  s.accounts = [];
  s.goals = [];
  s.seq = 0;
  s.lock = Promise.resolve();
  n = 0;
  vi.useRealTimers();
});

describe('confirming an XP income draft', () => {
  it('creates an INCOME movement on the position, with the reference of the capture, and confirms the capture', async () => {
    account();
    const p = position();
    const c = capture('XP_INCOME');
    const result = await confirmInvestmentCapture(scope, c.id, { positionId: p.id, date: '2026-11-24', amount: 12.34 });

    expect(result.created).toBe(true);
    expect(db.s.movements).toHaveLength(1);
    expect(db.s.movements[0]).toMatchObject({ householdId: HH, positionId: p.id, type: 'INCOME', sourceRef: `notif:${c.dedupKey}`, quantity: null, unitPrice: null });
    expect(db.s.movements[0]!.amount.toString()).toBe('12.34');
    expect(db.s.captures[0]).toMatchObject({ status: 'CONFIRMED', transactionId: null });
    expect(result.capture).toMatchObject({ id: c.id, status: 'CONFIRMED', movementId: db.s.movements[0]!.id });
    expect(result.positionCreated).toBe(false);
  });

  it('refuses a quantity on an income', async () => {
    account();
    const p = position();
    const c = capture('XP_INCOME');
    await expect(confirmInvestmentCapture(scope, c.id, { positionId: p.id, date: '2026-11-24', amount: 12.34, quantity: 1 })).rejects.toMatchObject({ statusCode: 400 });
    expect(db.s.captures[0]!.status).toBe('PENDING');
    expect(db.s.movements).toHaveLength(0);
  });

  it('twice does not create two movements: the second answers the first', async () => {
    account();
    const p = position();
    const c = capture('XP_INCOME');
    const body = { positionId: p.id, date: '2026-11-24', amount: 12.34 };
    const first = await confirmInvestmentCapture(scope, c.id, body);
    const second = await confirmInvestmentCapture(scope, c.id, body);
    expect(second.created).toBe(false);
    expect(second.movement.id).toBe(first.movement.id);
    expect(db.s.movements).toHaveLength(1);
  });

  it('two simultaneous confirmations create one movement', async () => {
    account();
    const p = position();
    const c = capture('XP_INCOME');
    const body = { positionId: p.id, date: '2026-11-24', amount: 12.34 };
    const results = await Promise.all([confirmInvestmentCapture(scope, c.id, body), confirmInvestmentCapture(scope, c.id, body)]);
    expect(db.s.movements).toHaveLength(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results[0].movement.id).toBe(results[1].movement.id);
  });

  it('confirmed capture whose movement was deleted answers 409 and does not create another', async () => {
    account();
    const p = position();
    const c = capture('XP_INCOME');
    const first = await confirmInvestmentCapture(scope, c.id, { positionId: p.id, date: '2026-11-24', amount: 12.34 });
    db.s.movements = db.s.movements.filter((m) => m.id !== first.movement.id);
    await expect(confirmInvestmentCapture(scope, c.id, { positionId: p.id, date: '2026-11-24', amount: 12.34 })).rejects.toBeInstanceOf(ConflictError);
    expect(db.s.movements).toHaveLength(0);
  });
});

describe('confirming an XP executed-reinvestment draft', () => {
  it('creates a BUY with the quantity the user confirmed; the unit price comes from amount / quantity', async () => {
    account();
    const p = position();
    opening(p.id);
    const c = capture('XP_REINVEST_DONE');
    const result = await confirmInvestmentCapture(scope, c.id, { positionId: p.id, date: '2026-11-24', amount: 7.77, quantity: 3 });
    expect(result.movement).toMatchObject({ type: 'BUY', quantity: 3, amount: 7.77, sourceRef: `notif:${c.dedupKey}` });
    expect(result.movement.unitPrice).toBe(2.59);
    expect(result.position.quantity).toBe(13);
  });

  it('needs the quantity (the server never invents one) and leaves the capture pending', async () => {
    account();
    const p = position();
    const c = capture('XP_REINVEST_DONE');
    await expect(confirmInvestmentCapture(scope, c.id, { positionId: p.id, date: '2026-11-24', amount: 7.77 })).rejects.toMatchObject({ statusCode: 400 });
    expect(db.s.captures[0]!.status).toBe('PENDING');
    expect(db.s.movements).toHaveLength(0);
  });
});

describe('position of the confirmation', () => {
  it('creates the position together when the ticker has none, in the same database transaction', async () => {
    account();
    const c = capture('XP_INCOME');
    const result = await confirmInvestmentCapture(scope, c.id, { newPosition: { accountId: ACC, name: 'Fundo Novo' }, date: '2026-11-24', amount: 12.34 });
    expect(result.positionCreated).toBe(true);
    expect(db.s.positions).toHaveLength(1);
    expect(db.s.positions[0]).toMatchObject({ householdId: HH, accountId: ACC, kind: 'STOCK_EXCHANGE', ticker: 'TEST11', name: 'Fundo Novo', savingsGoalId: null });
    expect(db.s.movements[0]!.positionId).toBe(db.s.positions[0]!.id);
  });

  it('the name defaults to the ticker and the goal is kept', async () => {
    account();
    db.s.goals.push({ id: '00000000-0000-4000-8000-000000000099', householdId: HH });
    const c = capture('XP_INCOME');
    await confirmInvestmentCapture(scope, c.id, { newPosition: { accountId: ACC, savingsGoalId: '00000000-0000-4000-8000-000000000099' }, date: '2026-11-24', amount: 12.34 });
    expect(db.s.positions[0]).toMatchObject({ name: 'TEST11', savingsGoalId: '00000000-0000-4000-8000-000000000099' });
  });

  it('an open position with the ticker already in the account is a 409 and nothing is written (rolled back)', async () => {
    account();
    position();
    const c = capture('XP_INCOME');
    await expect(confirmInvestmentCapture(scope, c.id, { newPosition: { accountId: ACC }, date: '2026-11-24', amount: 12.34 })).rejects.toBeInstanceOf(ConflictError);
    expect(db.s.captures[0]!.status).toBe('PENDING');
    expect(db.s.positions).toHaveLength(1);
    expect(db.s.movements).toHaveLength(0);
  });

  it('refuses a position of another ticker (400), of another household or account (404), a closed one and a non-investment account', async () => {
    account();
    account({ id: OTHER_ACC, householdId: OTHER_HH });
    const other = position({ ticker: 'ABCD11' });
    const foreign = position({ householdId: OTHER_HH, accountId: OTHER_ACC });
    const closed = position({ closedAt: day('2026-11-01') });
    db.s.accounts.push({ id: '00000000-0000-4000-8000-000000000003', householdId: HH, name: 'Corrente', type: 'CHECKING', isActive: true, balance: dec(0) });
    const c = capture('XP_INCOME');
    const body = { date: '2026-11-24', amount: 12.34 };
    await expect(confirmInvestmentCapture(scope, c.id, { ...body, positionId: other.id })).rejects.toMatchObject({ statusCode: 400 });
    await expect(confirmInvestmentCapture(scope, c.id, { ...body, positionId: foreign.id })).rejects.toMatchObject({ statusCode: 404 });
    await expect(confirmInvestmentCapture(scope, c.id, { ...body, positionId: closed.id })).rejects.toMatchObject({ statusCode: 400 });
    await expect(confirmInvestmentCapture(scope, c.id, { ...body, newPosition: { accountId: OTHER_ACC } })).rejects.toMatchObject({ statusCode: 404 });
    await expect(confirmInvestmentCapture(scope, c.id, { ...body, newPosition: { accountId: '00000000-0000-4000-8000-000000000003' } })).rejects.toMatchObject({ statusCode: 400 });
    expect(db.s.captures[0]!.status).toBe('PENDING');
    expect(db.s.movements).toHaveLength(0);
  });

  it('exactly one of position and newPosition', async () => {
    account();
    const c = capture('XP_INCOME');
    await expect(confirmInvestmentCapture(scope, c.id, { date: '2026-11-24', amount: 12.34 })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('only the XP drafts become movements, and only through this path', () => {
  it('refuses a capture of another app, a study text, a reinvestment notice and a dismissed draft', async () => {
    account();
    const p = position();
    const body = { positionId: p.id, date: '2026-11-24', amount: 12.34 };
    await expect(confirmInvestmentCapture(scope, capture('CARD_PURCHASE').id, body)).rejects.toMatchObject({ statusCode: 400 });
    await expect(confirmInvestmentCapture(scope, capture('XP_STUDY').id, body)).rejects.toMatchObject({ statusCode: 400 });
    await expect(confirmInvestmentCapture(scope, capture('XP_REINVEST_NOTICE').id, body)).rejects.toMatchObject({ statusCode: 400 });
    await expect(confirmInvestmentCapture(scope, capture('XP_INCOME', { status: 'DISMISSED' }).id, body)).rejects.toBeInstanceOf(ConflictError);
    expect(db.s.movements).toHaveLength(0);
  });

  it('a capture of another household is not found', async () => {
    account();
    const p = position();
    const c = capture('XP_INCOME', { householdId: OTHER_HH });
    await expect(confirmInvestmentCapture(scope, c.id, { positionId: p.id, date: '2026-11-24', amount: 12.34 })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('the transaction confirmation refuses an XP draft: it would be a lançamento', async () => {
    const c = capture('XP_INCOME');
    await expect(confirmCapture(scope, c.id, { accountId: ACC, categoryName: 'Outros', amount: 12.34, date: '2026-11-24', paid: true } as never)).rejects.toMatchObject({ statusCode: 400 });
    expect(db.s.captures[0]!.status).toBe('PENDING');
  });
});

describe('the box of captures and the study list', () => {
  it('study captures and reinvestment notices are out of the PENDING list and the counter', async () => {
    capture('XP_INCOME');
    capture('XP_REINVEST_DONE');
    capture('XP_REINVEST_NOTICE');
    capture('XP_STUDY');
    const page = await listCaptures(HH, { status: 'PENDING', limit: 20 });
    expect(page.data.map((d) => (d.parsed as Row).kind).sort()).toEqual(['XP_INCOME', 'XP_REINVEST_DONE']);
    expect(await countCaptures(HH, 'PENDING')).toBe(2);
  });

  it('lists the study captures of the household, newest first, with the day they will be deleted', async () => {
    capture('XP_STUDY', { postedAt: new Date('2026-11-20T10:00:00Z'), createdAt: new Date('2026-11-20T10:00:00Z') });
    capture('XP_STUDY', { postedAt: new Date('2026-11-22T10:00:00Z'), createdAt: new Date('2026-11-22T10:00:00Z') });
    capture('XP_STUDY', { householdId: OTHER_HH });
    capture('XP_INCOME');
    const page = await listStudyCaptures(HH, { package: XP, limit: 20 });
    expect(page.data).toHaveLength(2);
    expect(page.data[0]!.postedAt.toISOString()).toBe('2026-11-22T10:00:00.000Z');
    expect(page.data[0]!.expiresAt).toBe('2027-01-21T10:00:00.000Z');
    expect(Object.keys(page.data[0]!).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'package', 'postedAt', 'text', 'title']);
  });

  it('filters the study list by package', async () => {
    capture('XP_STUDY');
    capture('XP_STUDY', { package: 'com.example.other' });
    expect((await listStudyCaptures(HH, { package: 'com.example.other', limit: 20 })).data).toHaveLength(1);
    expect((await listStudyCaptures(HH, { limit: 20 })).data).toHaveLength(2);
  });
});

describe('the draft suggestion of an XP capture', () => {
  it('income: ticker, amount, the Brasilia day and the open positions of the ticker', async () => {
    account();
    const p = position();
    position({ ticker: 'ABCD11' });
    capture('XP_INCOME');
    const [item] = (await listCaptures(HH, { status: 'PENDING', limit: 20 })).data;
    expect(item!.suggestion.investment).toEqual({
      movementType: 'INCOME', ticker: 'TEST11', amount: 12.34, date: '2026-11-24', quantity: null, quote: null,
      positions: [{ id: p.id, accountId: ACC, name: 'Fundo Exemplo' }], pairedNotice: null,
    });
  });

  it('purchase: quantity = amount / last quote up to the day, nearest integer, at least 1; a newer quote is never read', async () => {
    account();
    position();
    db.s.quotes.push({ ticker: 'TEST11', date: day('2026-11-23'), close: dec(3.5) }, { ticker: 'TEST11', date: day('2026-11-25'), close: dec(1) });
    capture('XP_REINVEST_DONE', {}, { amountCents: 1000, amount: 10 });
    const [item] = (await listCaptures(HH, { status: 'PENDING', limit: 20 })).data;
    expect(item!.suggestion.investment).toMatchObject({ movementType: 'BUY', amount: 10, date: '2026-11-24', quantity: 3, quote: { price: 3.5, date: '2026-11-23' } });
  });

  it('purchase without a quote: no quantity suggested', async () => {
    capture('XP_REINVEST_DONE');
    const [item] = (await listCaptures(HH, { status: 'PENDING', limit: 20 })).data;
    expect(item!.suggestion.investment).toMatchObject({ movementType: 'BUY', quantity: null, quote: null, positions: [] });
  });

  it('pairs the executed purchase with the notice of the same ticker announced for that day (never as a draft itself)', async () => {
    const notice = capture('XP_REINVEST_NOTICE');
    capture('XP_REINVEST_NOTICE', {}, { ticker: 'ABCD11' });
    capture('XP_REINVEST_NOTICE', {}, { executionDate: '2026-11-30' });
    capture('XP_REINVEST_DONE');
    const [item] = (await listCaptures(HH, { status: 'PENDING', limit: 20 })).data;
    expect(item!.suggestion.investment!.pairedNotice).toEqual({ captureId: notice.id, amount: 12.34, announcedDate: '2026-11-24' });
  });

  it('transaction drafts keep the suggestion they had (no investment key)', async () => {
    capture('CARD_PURCHASE');
    const [item] = (await listCaptures(HH, { status: 'PENDING', limit: 20 })).data;
    expect('investment' in item!.suggestion).toBe(false);
  });
});

describe('intake of the three formats and an advertisement', () => {
  it('income and executed reinvestment become drafts, the notice is kept without a draft, the advertisement is study', async () => {
    const at = '2026-11-24T21:09:00.000Z';
    const results = await ingestCaptures(scope, [
      { package: XP, title: 'TEST11 pagou rendimentos!', text: 'Você recebeu R$ 12,34 e o valor já está disponível na sua conta.', postedAt: at },
      { package: XP, title: 'Reinvestimento de Proventos', text: 'Seu reinvestimento no valor de R$ 12,34 será executado no dia 24/11/2026 no ativo TEST11.', postedAt: at },
      { package: XP, title: 'Reinvestimento de Proventos realizado com sucesso', text: 'Seu reinvestimento no valor de R$ 7,77 foi realizado no ativo TEST11. O débito em sua conta investimento ocorrerá em 2 dias úteis.', postedAt: at },
      { package: XP, title: 'Invista agora', text: 'Aproveite taxas de até 14% ao ano.', postedAt: at },
    ]);
    expect(results.map((r) => r.status)).toEqual(['created', 'created', 'created', 'created']);
    expect(results.every((r) => r.notice === undefined)).toBe(true);
    expect(db.s.captures.map((c) => [c.parsed.kind, c.status])).toEqual([
      ['XP_INCOME', 'PENDING'],
      ['XP_REINVEST_NOTICE', 'IGNORED'],
      ['XP_REINVEST_DONE', 'PENDING'],
      ['XP_STUDY', 'STUDY'],
    ]);
    expect(await countCaptures(HH, 'PENDING')).toBe(2);
  });

  it('a reparse that finally understands a study text moves it to the box; one that still does not leaves it in study', async () => {
    capture('XP_STUDY', { parserVersion: 5, title: 'TEST11 pagou rendimentos!', text: 'Você recebeu R$ 12,34 e o valor já está disponível na sua conta.' });
    capture('XP_STUDY', { parserVersion: 5, title: 'Oferta', text: 'Invista.' });
    const result = await reparseCaptures(HH);
    expect(result).toMatchObject({ scanned: 2, updated: 2 });
    expect(db.s.captures.map((c) => [c.parsed.kind, c.status])).toEqual([['XP_INCOME', 'PENDING'], ['XP_STUDY', 'STUDY']]);
  });
});

describe('deleting the study captures after 60 days', () => {
  it('deletes the ones older than 60 days and keeps the rest', async () => {
    const old = capture('XP_STUDY', { createdAt: new Date(NOW.getTime() - 61 * DAY_MS) });
    const young = capture('XP_STUDY', { createdAt: new Date(NOW.getTime() - 59 * DAY_MS) });
    const fresh = capture('XP_STUDY', { createdAt: NOW });
    const count = await purgeStudyCaptures(NOW);
    expect(count).toBe(1);
    expect(db.s.captures.map((c) => c.id).sort()).toEqual([young.id, fresh.id].sort());
    expect(db.s.captures.some((c) => c.id === old.id)).toBe(false);
  });

  it('exactly 60 days is still kept', async () => {
    capture('XP_STUDY', { createdAt: new Date(NOW.getTime() - 60 * DAY_MS) });
    expect(await purgeStudyCaptures(NOW)).toBe(0);
  });

  it('never deletes a capture that is not in study, however old', async () => {
    const ancient = new Date(NOW.getTime() - 400 * DAY_MS);
    capture('XP_INCOME', { createdAt: ancient });
    capture('XP_REINVEST_NOTICE', { createdAt: ancient });
    capture('XP_INCOME', { createdAt: ancient, status: 'CONFIRMED' });
    capture('XP_INCOME', { createdAt: ancient, status: 'DISMISSED' });
    capture('CARD_PURCHASE', { createdAt: ancient });
    expect(await purgeStudyCaptures(NOW)).toBe(0);
    expect(db.s.captures).toHaveLength(5);
  });
});
