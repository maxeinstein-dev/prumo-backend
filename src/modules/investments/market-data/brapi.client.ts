/**
 * Client of brapi.dev (P21 L2): closing quotes, ONE request per ticker (`/quote/<TICKER>`, reading results[0], as the Rende does in production: the
 * free plan takes one asset per request), at most 3 at the same time, each with its own timeout.
 *
 * The token (BRAPI_TOKEN) goes only in the Authorization header. It is never put in the URL, never logged, never part
 * of a warning: failures are reported with fixed texts and, at most, the HTTP status. The client never throws for a
 * network, timeout, HTTP or parsing problem: it returns warnings, and the caller keeps whatever it already has.
 * `fetch` is injectable so tests never touch the network.
 */

export interface FetchedQuote {
  ticker: string;
  /** 'YYYY-MM-DD' of the quote. */
  date: string;
  /** Reais per unit. */
  close: number;
}

export interface QuotesResult {
  quotes: FetchedQuote[];
  warnings: string[];
}

export interface BrapiClient {
  fetchQuotes(tickers: readonly string[]): Promise<QuotesResult>;
}

export interface BrapiOptions {
  token: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** 'YYYY-MM-DD' used when the answer carries no time for a quote. */
  today?: () => string;
  baseUrl?: string;
  /** Waits between retries after HTTP 429 (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>;
}

const TICKER = /^[A-Z0-9]{1,12}$/;
const MAX_IN_FLIGHT = 3;
/** HTTP 429 (rate limit): wait and ask again, up to 3 times; a Retry-After in seconds wins, capped at 30 s. */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
const MAX_RETRY_AFTER_MS = 30_000;

function retryAfterMs(response: Response, fallback: number): number {
  const value = Number(response.headers?.get?.('retry-after'));
  return Number.isFinite(value) && value > 0 ? Math.min(value * 1000, MAX_RETRY_AFTER_MS) : fallback;
}

function dayOfTime(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000).toISOString().slice(0, 10);
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);
  }
  return null;
}

export function createBrapiClient(options: BrapiOptions): BrapiClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const baseUrl = options.baseUrl ?? 'https://brapi.dev/api/quote';
  const today = options.today ?? (() => new Date().toISOString().slice(0, 10));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function fetchOne(ticker: string): Promise<{ quote?: FetchedQuote; warning?: string }> {
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), timeoutMs); // per request: restarted for each retry
    try {
      let response = await doFetch(`${baseUrl}/${ticker}`, {
        headers: { Authorization: `Bearer ${options.token!.trim()}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      for (const delay of RETRY_DELAYS_MS) {
        if (response.status !== 429) break;
        clearTimeout(timer);
        await sleep(retryAfterMs(response, delay));
        timer = setTimeout(() => controller.abort(), timeoutMs);
        response = await doFetch(`${baseUrl}/${ticker}`, {
          headers: { Authorization: `Bearer ${options.token!.trim()}`, Accept: 'application/json' },
          signal: controller.signal,
        });
      }
      if (!response.ok) return { warning: `brapi answered HTTP ${response.status} for ${ticker}: quote not updated` };
      const body = (await response.json()) as { results?: unknown } | null;
      const results = body?.results;
      if (!Array.isArray(results)) return { warning: `brapi answered in an unexpected format for ${ticker}: quote not updated` };
      const item = results[0] as Record<string, unknown> | undefined; // as the Rende does: results[0]
      if (!item) return { warning: `No quote returned for ${ticker}` };
      const price = item.regularMarketPrice;
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return { warning: `No usable price for ${ticker}` };
      return { quote: { ticker, date: dayOfTime(item.regularMarketTime) ?? today(), close: price } };
    } catch {
      return { warning: `brapi unavailable (${controller.signal.aborted ? 'timeout' : 'network error'}) for ${ticker}: quote not updated` };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async fetchQuotes(requested) {
      const warnings: string[] = [];
      const wanted = [...new Set(requested.map((t) => t.trim().toUpperCase()).filter((t) => t.length > 0))];
      if (wanted.length === 0) return { quotes: [], warnings };
      if (!options.token || options.token.trim() === '') {
        return { quotes: [], warnings: ['BRAPI_TOKEN is not set: quotes skipped'] };
      }
      const valid = wanted.filter((t) => TICKER.test(t));
      for (const t of wanted) if (!TICKER.test(t)) warnings.push('Ignored a malformed ticker');
      if (valid.length === 0) return { quotes: [], warnings };

      // One request per ticker (the free plan takes one asset per request), at most MAX_IN_FLIGHT at a time. A failure
      // is a warning about that ticker only and never stops the others. Results keep the order of the request.
      const outcomes = new Array<{ quote?: FetchedQuote; warning?: string }>(valid.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < valid.length) {
          const i = next++;
          outcomes[i] = await fetchOne(valid[i]!);
        }
      };
      await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, valid.length) }, worker));
      const quotes: FetchedQuote[] = [];
      for (const o of outcomes) {
        if (o?.quote) quotes.push(o.quote);
        if (o?.warning) warnings.push(o.warning);
      }
      return { quotes, warnings };
    },
  };
}
