import { beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError } from '../../shared/errors/index.js';
import {
  amountsEqual,
  assertNotCardInvoice,
  buildImportPreview,
  confirmImport,
  flagDuplicates,
  getDayRange,
  parseImportBuffer,
} from './import.service.js';
import type { ParsedRow } from './parsers/statement.common.js';
import { createTransaction } from './transactions.service.js';

const lock = { $queryRaw: vi.fn(async () => [{ locked: true }]) };
vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    transaction: { findMany: vi.fn() },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(lock)),
  },
}));
vi.mock('./transactions.service.js', () => ({ createTransaction: vi.fn() }));

const findMany = vi.mocked(prisma.transaction.findMany);
const create = vi.mocked(createTransaction);

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const row = (description: string, amount = 10, date = '2026-11-05', type: ParsedRow['type'] = 'EXPENSE'): ParsedRow => ({
  date: day(date),
  description,
  amount,
  type,
});
const stored = (description: string, amount = 10, date = '2026-11-05', type = 'EXPENSE') =>
  ({ description, amount: { toString: () => String(amount), valueOf: () => amount }, date: day(date), type }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  let n = 0;
  create.mockImplementation(async () => ({ id: `tx-${++n}` }) as never);
});

describe('parseImportBuffer (pure, no DB)', () => {
  it('picks the parser by extension, case-insensitive', () => {
    const csv = parseImportBuffer('extrato.csv', Buffer.from('data;descricao;valor\n15/01/2024;Salario;2500.00\n'));
    const ofx = parseImportBuffer(
      'Extrato.OFX',
      Buffer.from('<OFX><STMTTRN><DTPOSTED>20240115\n<TRNAMT>2500.00\n<MEMO>Salary\n</STMTTRN></OFX>'),
    );

    expect(csv.rows).toHaveLength(1);
    expect(ofx.rows[0]?.description).toBe('Salary');
  });

  it('decodes a Windows-1252 file (accents) and a UTF-8 one alike, and ignores a byte order mark', () => {
    const entry = (memo: Buffer) => Buffer.concat([Buffer.from('<OFX><STMTTRN><DTPOSTED>20240115\n<TRNAMT>-2.00\n<MEMO>'), memo, Buffer.from('\n</STMTTRN></OFX>')]);

    expect(parseImportBuffer('a.ofx', entry(Buffer.from('Café São João', 'latin1'))).rows[0]?.description).toBe('Café São João');
    expect(parseImportBuffer('a.ofx', entry(Buffer.from('Café São João', 'utf-8'))).rows[0]?.description).toBe('Café São João');
    const csv = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('data;descricao;valor\n15/01/2024;Salario;2500,00\n')]);
    expect(parseImportBuffer('a.csv', csv).rows).toHaveLength(1);
  });

  it('reports the lines it could not read, with the entities of a memo already decoded', () => {
    const parsed = parseImportBuffer('a.ofx', Buffer.from('<STMTTRN><DTPOSTED>20240115\n<TRNAMT>-2.00\n<MEMO>AT&amp;T\n</STMTTRN><STMTTRN><DTPOSTED>x\n<TRNAMT>-1.00\n</STMTTRN>'));

    expect(parsed.rows.map((r) => r.description)).toEqual(['AT&T']);
    expect(parsed.skipped).toEqual([{ line: 2, reason: 'invalid-date' }]);
  });

  it('rejects unsupported extensions with 400', () => {
    // asserted via statusCode, not instanceof: AppError resets its prototype (pre-existing quirk, out of scope)
    expect(() => parseImportBuffer('extrato.txt', Buffer.from('x'))).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('rejects a file with nothing to read, but not one whose lines were all skipped (the preview explains those)', () => {
    expect(() => parseImportBuffer('a.csv', Buffer.from('\n'))).toThrowError(expect.objectContaining({ statusCode: 400 }));
    const parsed = parseImportBuffer('a.csv', Buffer.from('data;descricao;valor\n32/13/2024;X;1,00\n'));
    expect(parsed.rows).toEqual([]);
    expect(parsed.skipped).toHaveLength(1);
  });
});

describe('flagDuplicates', () => {
  it('flags nothing on an empty account, even for identical rows in the same file', async () => {
    expect(await flagDuplicates('acc', 'hh', [row('Coffee'), row('Coffee')])).toEqual([false, false]);
  });

  it('compares by occurrence: one stored copy covers only the first of two identical rows', async () => {
    findMany.mockResolvedValue([stored('Coffee')]);

    expect(await flagDuplicates('acc', 'hh', [row('Coffee'), row('Coffee')])).toEqual([true, false]);
  });

  it('flags every copy once the account already holds as many as the file', async () => {
    findMany.mockResolvedValue([stored('Coffee'), stored('Coffee')]);

    expect(await flagDuplicates('acc', 'hh', [row('Coffee'), row('Coffee')])).toEqual([true, true]);
  });

  it('tells rows apart by day, amount, description and direction', async () => {
    findMany.mockResolvedValue([stored('Coffee')]);

    const flags = await flagDuplicates('acc', 'hh', [
      row('Coffee', 10, '2026-11-06'),
      row('Coffee', 10.5),
      row('Tea'),
      row('Coffee', 10, '2026-11-05', 'INCOME'),
      row('Coffee'),
    ]);

    expect(flags).toEqual([false, false, false, false, true]);
  });

  it('loads the account in one query bounded by the first and last day of the file', async () => {
    await flagDuplicates('acc', 'hh', [row('A', 1, '2026-11-09'), row('B', 1, '2026-11-02'), row('C', 1, '2026-11-05')]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      householdId: 'hh',
      accountId: 'acc',
      date: { gte: day('2026-11-02'), lte: day('2026-11-09') },
    });
  });

  it('does not query for an empty list', async () => {
    expect(await flagDuplicates('acc', 'hh', [])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('buildImportPreview', () => {
  it('counts new and duplicate rows with the same flags the confirm will use, and reports the skipped lines', async () => {
    findMany.mockResolvedValue([stored('Coffee')]);

    const preview = await buildImportPreview('acc', 'hh', {
      rows: [row('Coffee'), row('Coffee'), row('Tea')],
      skipped: [{ line: 7, reason: 'invalid-date' }],
    });

    expect(preview).toMatchObject({
      total: 3,
      duplicateCount: 1,
      newCount: 2,
      skippedCount: 1,
      skipped: [{ line: 7, reason: 'invalid-date' }],
    });
    expect(preview.rows.map((r) => r.duplicate)).toEqual([true, false, false]);
  });
});

describe('confirmImport', () => {
  it('takes the per-account advisory lock before it reads or writes anything', async () => {
    await confirmImport('acc', 'hh', [row('Coffee')], 'user-1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(lock.$queryRaw).toHaveBeenCalledTimes(1);
    // The key is namespaced, so it cannot collide with a lock another feature takes on the same account id
    expect((lock.$queryRaw.mock.calls[0] as unknown[])[1]).toBe('statement-import:acc');
    expect(lock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(findMany.mock.invocationCallOrder[0] as number);
    expect(findMany.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0] as number);
  });

  it('creates only the rows that are not on the account and counts the others as skipped', async () => {
    findMany.mockResolvedValue([stored('Coffee')]);

    const result = await confirmImport('acc', 'hh', [row('Coffee'), row('Coffee'), row('Salary', 100, '2026-11-06', 'INCOME')], 'user-1');

    expect(result).toEqual({ imported: 2, skipped: 1, ids: ['tx-1', 'tx-2'] });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ householdId: 'hh', accountId: 'acc', description: 'Coffee', type: 'EXPENSE', paid: true });
    expect(create.mock.calls[1]?.[0]).toMatchObject({ description: 'Salary', type: 'INCOME', categoryName: 'OTHER_INCOME' });
    expect(create.mock.calls[0]?.[1]).toBe('user-1');
  });

  it('imports nothing and writes nothing when every row is a duplicate', async () => {
    findMany.mockResolvedValue([stored('Coffee')]);

    expect(await confirmImport('acc', 'hh', [row('Coffee')])).toEqual({ imported: 0, skipped: 1, ids: [] });
    expect(create).not.toHaveBeenCalled();
  });

  it('lets the error of a failing row through; the rows before it stay saved and count as duplicates when the file is sent again', async () => {
    create.mockResolvedValueOnce({ id: 'tx-1' } as never).mockRejectedValueOnce(new Error('database went away'));

    await expect(confirmImport('acc', 'hh', [row('A'), row('B'), row('C')])).rejects.toThrow('database went away');
    expect(create).toHaveBeenCalledTimes(2);

    findMany.mockResolvedValue([stored('A')]);
    create.mockClear();
    expect(await confirmImport('acc', 'hh', [row('A'), row('B'), row('C')])).toMatchObject({ imported: 2, skipped: 1 });
  });

  it('answers 409 and touches nothing when another import of the account holds the lock', async () => {
    lock.$queryRaw.mockResolvedValueOnce([{ locked: false }]);

    await expect(confirmImport('acc', 'hh', [row('Coffee')])).rejects.toMatchObject({ statusCode: 409 });
    expect(findMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

const OFX_VALID = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240115120000
<TRNAMT>2500.00
<MEMO>Salario mensal
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;

describe('dedup pure helpers (DB-free)', () => {
  it('getDayRange is the single UTC day the row is stored on, not a span reaching into the next day', () => {
    const { start, end } = getDayRange(new Date(Date.UTC(2024, 0, 15, 17, 30, 0)));

    expect(start.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    expect(end.toISOString()).toBe('2024-01-15T00:00:00.000Z');
  });

  it('amountsEqual tolerates float noise but not real cent differences', () => {
    expect(amountsEqual(89.9, 89.9)).toBe(true);
    expect(amountsEqual(0.1 + 0.2, 0.3)).toBe(true);
    expect(amountsEqual(100, 100.01)).toBe(false);
    expect(amountsEqual(100, 101)).toBe(false);
  });
});

const CARD_INVOICE = `OFXHEADER:100
DATA:OFXSGML
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261105<TRNAMT>-10.00<FITID>c1<MEMO>Padaria Exemplo
</STMTTRN>
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>
`;

describe('assertNotCardInvoice (generic importer guard)', () => {
  it('sends a card invoice on a credit card to the card importer with a 400', () => {
    try {
      assertNotCardInvoice('CREDIT', 'Fatura.OFX', Buffer.from(CARD_INVOICE, 'utf-8'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as BadRequestError).statusCode).toBe(400);
      expect((error as BadRequestError).message).toContain('/transactions/import/card-ofx/preview');
    }
  });

  it('lets bank statements, CSV files and other account types through', () => {
    expect(() => assertNotCardInvoice('CREDIT', 'extrato.ofx', Buffer.from(OFX_VALID, 'utf-8'))).not.toThrow();
    expect(() => assertNotCardInvoice('CREDIT', 'fatura.csv', Buffer.from(CARD_INVOICE, 'utf-8'))).not.toThrow();
    expect(() => assertNotCardInvoice('CHECKING', 'fatura.ofx', Buffer.from(CARD_INVOICE, 'utf-8'))).not.toThrow();
  });
});
