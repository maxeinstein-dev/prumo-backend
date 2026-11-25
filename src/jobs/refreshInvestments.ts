/**
 * Daily routine of the investments (P21 L2). Run once a day, after the market close (the run of the day stores the close it
 * finds, and a later run of the same day only replaces it):
 *   1. closes of the tickers with an open position (brapi, one request per ticker; needs BRAPI_TOKEN in the environment);
 *   2. CDI / Selic / IPCA since the last stored day (Banco Central, no key);
 *   3. the snapshot of each investment account that holds positions, into account_valuations.
 *
 * A fetch problem is only a warning (nothing stored is erased; the snapshot uses the last known values). The process exits
 * with an error when something really fails: a database error, or a snapshot that could not be recorded.
 * No server is started. Prints counts only: no tokens, amounts or names.
 */
import 'dotenv/config';
import '../shared/config/env.js';

import { prisma } from '../shared/db/prisma.js';
import { runInvestmentRefresh, type RefreshResult } from '../modules/investments/investments.refresh.js';
import { createBcbClient } from '../modules/investments/market-data/bcb.client.js';
import { createBrapiClient } from '../modules/investments/market-data/brapi.client.js';

export async function runInvestmentsJob(options: { today?: string; env?: { BRAPI_TOKEN?: string } } = {}): Promise<RefreshResult> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const env = options.env ?? process.env;
  console.log(`[InvestmentsJob] Starting for ${today}`);
  const result = await runInvestmentRefresh({
    brapi: createBrapiClient({ token: env.BRAPI_TOKEN, today: () => today }),
    bcb: createBcbClient(),
    today,
  });
  for (const warning of result.warnings) console.warn(`[InvestmentsJob] WARNING: ${warning}`);
  console.log(
    `[InvestmentsJob] Finished. Quotes saved: ${result.quotesSaved}, rates saved: ${result.ratesSaved}, ` +
      `snapshots recorded: ${result.snapshots.length}, warnings: ${result.warnings.length}`,
  );
  return result;
}

async function main() {
  let code = 0;
  try {
    await runInvestmentsJob();
  } catch (error) {
    // Only the id list of an InvestmentRefreshError; for anything else, the message of the fault.
    console.error('[InvestmentsJob] ❌ Fatal error:', error instanceof Error ? error.message : 'Unknown error');
    code = 1;
  } finally {
    await prisma.$disconnect();
  }
  process.exit(code);
}

const isMainModule = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMainModule || process.argv[1]?.includes('refreshInvestments')) {
  main();
}

export { main as runCronJob };
