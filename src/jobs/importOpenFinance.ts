/**
 * Daily Open Finance import (P25 L2c), run by the prumo-ops workflow "Open Finance" after Meu Pluggy's daily update.
 * Imports every household with a linked account (modules/open-finance/open-finance.import.ts), one after the other,
 * with ONE Pluggy client for the whole run (the keys are traded for an API key once). A blocked bank (expired
 * authorization) or a failing household does not stop the others; the run fails at the end so the workflow opens its
 * issue (the e-mail), saying which connection to renew. Never prints the keys.
 */
import 'dotenv/config';
import '../shared/config/env.js';

import { prisma } from '../shared/db/prisma.js';
import { importOpenFinance, type ImportDb, type ImportResult } from '../modules/open-finance/open-finance.import.js';
import { createPluggyClient } from '../modules/open-finance/pluggy.client.js';

export class OpenFinanceJobError extends Error {
  constructor(problems: string[]) {
    super(`Open Finance import had ${problems.length} problem(s): ${problems.join(' | ')}`);
    this.name = 'OpenFinanceJobError';
  }
}

export interface JobSummary {
  households: number;
  refs: number;
  drafts: number;
  transferDrafts: number;
  yieldDrafts: number;
  blocked: ImportResult['blocked'];
}

interface JobDb {
  openFinanceLink: { findMany(args: unknown): Promise<Array<{ householdId: string }>> };
}

export async function runOpenFinanceJob(input: {
  db: JobDb;
  runImport: (args: { householdId: string }) => Promise<ImportResult>;
}): Promise<JobSummary> {
  const households = (
    await input.db.openFinanceLink.findMany({
      where: { pluggyAccountId: { not: null }, accountId: { not: null } },
      distinct: ['householdId'],
      select: { householdId: true },
    })
  ).map((row) => row.householdId);

  const summary: JobSummary = { households: households.length, refs: 0, drafts: 0, transferDrafts: 0, yieldDrafts: 0, blocked: [] };
  const problems: string[] = [];
  for (const householdId of households) {
    try {
      const result = await input.runImport({ householdId });
      summary.refs += result.refs;
      summary.drafts += result.drafts;
      summary.transferDrafts += result.transferDrafts;
      summary.yieldDrafts += result.yieldDrafts;
      summary.blocked.push(...result.blocked);
      for (const b of result.blocked) problems.push(`connection ${b.itemId.slice(0, 8)}: ${b.reason}`);
    } catch (error) {
      problems.push(`household ${householdId.slice(0, 8)}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  if (problems.length > 0) throw new OpenFinanceJobError(problems);
  return summary;
}

async function main() {
  let code = 0;
  try {
    const client = createPluggyClient({ clientId: process.env.PLUGGY_CLIENT_ID, clientSecret: process.env.PLUGGY_CLIENT_SECRET });
    const summary = await runOpenFinanceJob({
      db: prisma as unknown as JobDb,
      runImport: ({ householdId }) => importOpenFinance({ householdId, db: prisma as unknown as ImportDb, client }),
    });
    console.log(
      `[OpenFinanceJob] households: ${summary.households}, references: ${summary.refs}, drafts: ${summary.drafts}, ` +
        `transfer drafts: ${summary.transferDrafts}, yield drafts: ${summary.yieldDrafts}`,
    );
  } catch (error) {
    console.error('[OpenFinanceJob] ❌', error instanceof Error ? error.message : 'Unknown error');
    code = 1;
  } finally {
    await prisma.$disconnect();
  }
  process.exit(code);
}

const isMainModule = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMainModule || process.argv[1]?.includes('importOpenFinance')) {
  main();
}
