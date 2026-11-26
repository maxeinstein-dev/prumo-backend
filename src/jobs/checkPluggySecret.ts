/**
 * Daily check of the Pluggy Client Secret (P25 L6), run by the prumo-ops workflow "Segredo da Pluggy".
 * Logic in modules/open-finance/secret-reminder.ts. This entry point only wires the database, the Pluggy client and
 * the output for the workflow: `notify=true` when a new reminder was written (the workflow then opens or comments its
 * issue, which is the e-mail). It never prints the keys.
 */
import 'dotenv/config';
import '../shared/config/env.js';

import { appendFileSync } from 'node:fs';

import { prisma } from '../shared/db/prisma.js';
import { createPluggyClient } from '../modules/open-finance/pluggy.client.js';
import { runPluggySecretCheck, type SecretCheckDb, type SecretCheckResult } from '../modules/open-finance/secret-reminder.js';

/** Lines for $GITHUB_OUTPUT: only the status, the date and the stage; no key. `notify=true` (the workflow opens or
 * comments its issue, which is the e-mail) only when a new reminder was written, so the e-mail goes once per stage. */
export function workflowOutput(result: SecretCheckResult): string {
  const lines = [`status=${result.status}`, `notify=${result.notified > 0}`];
  if (result.status !== 'not_configured') lines.push(`expires_on=${result.expiresOn}`, `days_left=${result.daysLeft}`);
  if (result.status === 'due' || result.status === 'refused') lines.push(`stage=${result.stage}`);
  return `${lines.join('\n')}\n`;
}

async function main() {
  let code = 0;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const client = createPluggyClient({ clientId: process.env.PLUGGY_CLIENT_ID, clientSecret: process.env.PLUGGY_CLIENT_SECRET });
    const result = await runPluggySecretCheck({
      env: {
        PLUGGY_CLIENT_ID: process.env.PLUGGY_CLIENT_ID,
        PLUGGY_CLIENT_SECRET: process.env.PLUGGY_CLIENT_SECRET,
        PLUGGY_SECRET_CREATED_AT: process.env.PLUGGY_SECRET_CREATED_AT,
      },
      today,
      db: prisma as unknown as SecretCheckDb,
      checkCredentials: () => client.checkCredentials(),
    });
    const output = workflowOutput(result);
    console.log(`[PluggySecret] ${output.trim().replace(/\n/g, ', ')}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  } catch (error) {
    console.error('[PluggySecret] ❌ Fatal error:', error instanceof Error ? error.message : 'Unknown error');
    code = 1;
  } finally {
    await prisma.$disconnect();
  }
  process.exit(code);
}

const isMainModule = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMainModule || process.argv[1]?.includes('checkPluggySecret')) {
  main();
}
