import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Structural guard (P21, risk "contar duas vezes"): confirming an XP draft writes an investment movement and nothing
 * else. These files may never create a lançamento (Transaction) nor move the stored balance of an account.
 */
const dir = dirname(fileURLToPath(import.meta.url));
const files = ['captures.xp.ts', 'capture-xp.ts'].map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));

const forbidden: Array<[string, RegExp]> = [
  ['a Transaction model access', /\b(prisma|tx|db)\s*\.\s*transaction\s*\./],
  ['the transactions service', /transactions\.service|createTransaction|createTransfer/],
  ['a write to the stored balance of an account', /\.\s*account\s*\.\s*(update|updateMany|upsert|create)\b/],
  ['the balance service', /balance\.service/],
  ['the account row lock helper', /lock-accounts/],
  ['a raw write to transactions or accounts', /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(transactions|accounts)\b/i],
];

describe('the XP confirmation never touches transactions or account balances', () => {
  it('found the sources', () => {
    expect(files.every((f) => f.text.length > 100)).toBe(true);
  });
  it.each(forbidden)('has no %s', (label, pattern) => {
    const hits = files.filter((f) => pattern.test(f.text)).map((f) => f.file);
    expect(hits, `${label} in ${hits.join(', ')}`).toEqual([]);
  });
});
