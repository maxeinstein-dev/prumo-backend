import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * The statement importer against a real PostgreSQL. The unit tests prove the rules on mocks; only the database proves
 * what two identical rows, a 23:59:59 date and two confirms at once do to the stored transactions.
 *
 * Opt-in: set TEST_DATABASE_ADMIN_URL to a throwaway server (any database of it). The test creates its own scratch
 * database, applies the migrations, runs the scenarios and drops it. Never point it at a server that holds real data.
 *   TZ=America/Sao_Paulo TEST_DATABASE_ADMIN_URL=... npx vitest run src/modules/transactions/import.db.test.ts
 *   TZ=UTC               TEST_DATABASE_ADMIN_URL=... npx vitest run src/modules/transactions/import.db.test.ts
 */
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;

// Same client as the app, over a pool the test can end, so the scratch database can be dropped quietly.
vi.mock('../../shared/db/prisma.js', async () => {
  const { PrismaClient } = await import('../../generated/prisma/client.js');
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  return { prisma: new PrismaClient({ adapter: new PrismaPg(pool) }), testPool: pool };
});

const ofx = (entries: Array<{ date: string; amount: string; memo: string }>): Buffer =>
  Buffer.from(
    [
      'OFXHEADER:100',
      'DATA:OFXSGML',
      'VERSION:102',
      '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>',
      ...entries.map((e, i) => `<STMTTRN>\n<TRNTYPE>DEBIT\n<DTPOSTED>${e.date}\n<TRNAMT>${e.amount}\n<FITID>id${i}\n<MEMO>${e.memo}\n</STMTTRN>`),
      '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    ].join('\n'),
    'utf8',
  );

describe.skipIf(!adminUrl)('statement import on a real database', () => {
  const scratch = `recta_test_import_${Date.now()}`;
  const admin = new pg.Client({ connectionString: adminUrl });

  let prisma: typeof import('../../shared/db/prisma.js').prisma;
  let pool: pg.Pool;
  let svc: typeof import('./import.service.js');
  let householdId: string;

  const newAccount = async (name: string) => (await prisma.account.create({ data: { householdId, name, type: 'CHECKING', balance: 0 } })).id;
  const count = (accountId: string) => prisma.transaction.count({ where: { accountId } });
  const day = (date: Date) => date.toISOString().slice(0, 10);

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${scratch}"`);
    const scratchUrl = new URL(adminUrl!);
    scratchUrl.pathname = `/${scratch}`;
    execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env, DATABASE_URL: scratchUrl.toString() } });
    process.env.DATABASE_URL = scratchUrl.toString();
    const db = (await import('../../shared/db/prisma.js')) as unknown as { prisma: typeof prisma; testPool: pg.Pool };
    prisma = db.prisma;
    pool = db.testPool;
    svc = await import('./import.service.js');
    householdId = (await prisma.household.create({ data: { name: 'Test household' } })).id;
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${scratch}"`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  it('two identical rows in one file are two transactions, and the same file again is two duplicates', async () => {
    const accountId = await newAccount('coffee');
    const parsed = svc.parseImportBuffer('a.ofx', ofx([
      { date: '20261105', amount: '-10.00', memo: 'Coffee' },
      { date: '20261105', amount: '-10.00', memo: 'Coffee' },
    ]));

    expect((await svc.buildImportPreview(accountId, householdId, parsed)).newCount).toBe(2);
    const result = await svc.confirmImport(accountId, householdId, parsed.rows);

    expect(result).toMatchObject({ imported: 2, skipped: 0 });
    expect(await count(accountId)).toBe(2);
    expect((await svc.buildImportPreview(accountId, householdId, parsed)).duplicateCount).toBe(2);
    expect(await svc.confirmImport(accountId, householdId, parsed.rows)).toMatchObject({ imported: 0, skipped: 2 });
  });

  it('three in the file and one in the account: the preview says 1 duplicate and the confirm of the whole file adds 2', async () => {
    const accountId = await newAccount('three');
    const bus = { date: '20261106', amount: '-4.50', memo: 'Bus' };
    await svc.confirmImport(accountId, householdId, svc.parseImportBuffer('b.ofx', ofx([bus])).rows);

    const parsed = svc.parseImportBuffer('c.ofx', ofx([bus, bus, bus]));
    const preview = await svc.buildImportPreview(accountId, householdId, parsed);
    const result = await svc.confirmImport(accountId, householdId, preview.rows);

    expect(preview).toMatchObject({ duplicateCount: 1, newCount: 2 });
    expect(result).toMatchObject({ imported: 2, skipped: 1 });
    expect(await count(accountId)).toBe(3);
  });

  it('a 23:59:59 posting is stored on the day the bank printed, and the account balance follows', async () => {
    const accountId = await newAccount('late');
    const parsed = svc.parseImportBuffer('d.ofx', ofx([{ date: '20261105235959', amount: '-7.00', memo: 'Late night' }]));

    await svc.confirmImport(accountId, householdId, parsed.rows);

    const stored = await prisma.transaction.findFirstOrThrow({ where: { accountId } });
    expect(day(stored.date)).toBe('2026-11-05');
    expect(Number((await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).balance)).toBe(-7);
    // and the same file is recognised as already imported (the day compared is the stored one)
    expect((await svc.buildImportPreview(accountId, householdId, parsed)).duplicateCount).toBe(1);
  });

  it('two confirms of the same file at once import it once: the other answers 409 without waiting', async () => {
    const accountId = await newAccount('race');
    const parsed = svc.parseImportBuffer('e.ofx', ofx(Array.from({ length: 20 }, (_, i) => ({ date: '20261107', amount: `-${i + 1}.00`, memo: `Race ${i}` }))));

    const results = await Promise.allSettled([
      svc.confirmImport(accountId, householdId, parsed.rows),
      svc.confirmImport(accountId, householdId, parsed.rows),
    ]);

    expect(await count(accountId)).toBe(20);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0]?.reason as { statusCode?: number }).statusCode).toBe(409);
    // the lock is released with the transaction: the same request goes through afterwards, as duplicates only
    expect(await svc.confirmImport(accountId, householdId, parsed.rows)).toMatchObject({ imported: 0, skipped: 20 });
  });

  it('looks the account up once for the whole file, not once per row', async () => {
    const accountId = await newAccount('batch');
    const parsed = svc.parseImportBuffer('f.ofx', ofx(Array.from({ length: 300 }, (_, i) => ({ date: '20261108', amount: `-${(i % 90) + 1}.${String(i % 100).padStart(2, '0')}`, memo: `Batch ${i}` }))));
    const original = prisma.transaction.findMany.bind(prisma.transaction);
    let lookups = 0;
    prisma.transaction.findMany = ((...args: Parameters<typeof original>) => {
      lookups += 1;
      return original(...args);
    }) as typeof prisma.transaction.findMany;
    try {
      await svc.buildImportPreview(accountId, householdId, parsed);
    } finally {
      prisma.transaction.findMany = original as typeof prisma.transaction.findMany;
    }

    expect(lookups).toBe(1);
  });
});
