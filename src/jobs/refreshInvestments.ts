/**
 * Daily routine of the investments (P21 L2). Run once a day, after the market close (the run of the day stores the close it
 * finds, and a later run of the same day only replaces it):
 *   1. closes of the tickers with an open position (brapi, one request per ticker; needs BRAPI_TOKEN in the environment);
 *   2. CDI / Selic / IPCA since the last stored day (Banco Central, no key);
 *   3. the snapshot of each investment account that holds positions, into account_valuations.
 *
 * A fetch problem is only a warning (nothing stored is erased; the snapshot uses the last known values). The process exits
 * with an error when something really fails: a database error, a snapshot that could not be recorded, or market data
 * that is still stale after the fetch (investments.staleness.ts), so the workflow opens its issue.
 * No server is started. Prints counts only: no tokens, amounts or names.
 */
import 'dotenv/config';
import '../shared/config/env.js';

import { prisma } from '../shared/db/prisma.js';
import { purgeStudyCaptures } from '../modules/captures/captures.xp.js';
import { runInvestmentRefresh, type RefreshResult } from '../modules/investments/investments.refresh.js';
import { isStale, StaleMarketDataError } from '../modules/investments/investments.staleness.js';
import { createBcbClient } from '../modules/investments/market-data/bcb.client.js';
import { createBrapiClient } from '../modules/investments/market-data/brapi.client.js';

export async function runInvestmentsJob(options: { today?: string; env?: { BRAPI_TOKEN?: string } } = {}): Promise<RefreshResult> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const env = options.env ?? process.env;
  console.log(`[InvestmentsJob] Starting for ${today}`);
  // P21 L6: the XP notifications "em estudo" are deleted after 60 days. A failure here does not stop the quotes and the
  // snapshots, but it fails the run (a database error is a real fault).
  let purged = 0;
  let purgeError: unknown;
  try {
    purged = await purgeStudyCaptures();
  } catch (error) {
    purgeError = error;
    console.error('[InvestmentsJob] Could not delete the old XP captures in study:', error instanceof Error ? error.message : 'Unknown error');
  }
  console.log(`[InvestmentsJob] Study captures deleted: ${purged}`);
  const result = await runInvestmentRefresh({
    brapi: createBrapiClient({ token: env.BRAPI_TOKEN, today: () => today }),
    bcb: createBcbClient(),
    today,
  });
  if (purgeError) throw purgeError;
  for (const warning of result.warnings) console.warn(`[InvestmentsJob] WARNING: ${warning}`);
  console.log(
    `[InvestmentsJob] Finished. Quotes saved: ${result.quotesSaved}, rates saved: ${result.ratesSaved}, ` +
      `snapshots recorded: ${result.snapshots.length}, warnings: ${result.warnings.length}`,
  );
  // Stale quotes or index rates fail the run (the workflow opens its issue); everything above was already done.
  if (isStale(result.stale)) throw new StaleMarketDataError(result.stale);
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
