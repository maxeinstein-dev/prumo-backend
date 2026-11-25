import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Structural guard (P21, risk "contar duas vezes"): the investments module may never create a lançamento (Transaction)
 * nor move the stored balance of an account. The aporte is a transfer (already in the balance) and a buy consumes it;
 * a Transaction for the same buy would take the money out twice, and an income is not the month's revenue.
 */
const dir = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));

const forbidden: Array<[string, RegExp]> = [
  ['a Transaction model access', /\b(prisma|tx|db)\s*\.\s*transaction\s*\./],
  ['a write to the stored balance of an account', /\.\s*account\s*\.\s*(update|updateMany|upsert|create)\b/],
  ['the balance service', /balance\.service/],
  ['the account row lock helper', /lock-accounts/],
  ['a raw write to transactions or accounts', /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(transactions|accounts)\b/i],
];

describe('investments module never touches transactions or account balances', () => {
  it('found the module sources', () => {
    expect(sources.length).toBeGreaterThan(2);
  });
  it.each(forbidden)('has no %s', (label, pattern) => {
    const hits = sources.filter((s) => pattern.test(s.text)).map((s) => s.file);
    expect(hits, `${label} in ${hits.join(', ')}`).toEqual([]);
  });
});
