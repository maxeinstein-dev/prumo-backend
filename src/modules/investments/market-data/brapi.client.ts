/**
 * Client of brapi.dev (P21 L2): closing quotes of several tickers in ONE call.
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
}

const TICKER = /^[A-Z0-9]{1,12}$/;

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

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let body: unknown;
      try {
        const response = await doFetch(`${baseUrl}/${valid.join(',')}`, {
          headers: { Authorization: `Bearer ${options.token.trim()}`, Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) return { quotes: [], warnings: [...warnings, `brapi answered HTTP ${response.status}: quotes not updated`] };
        body = await response.json();
      } catch {
        const reason = controller.signal.aborted ? 'timeout' : 'network error';
        return { quotes: [], warnings: [...warnings, `brapi unavailable (${reason}): quotes not updated`] };
      } finally {
        clearTimeout(timer);
      }

      const results = (body as { results?: unknown } | null)?.results;
      if (!Array.isArray(results)) return { quotes: [], warnings: [...warnings, 'brapi answered in an unexpected format: quotes not updated'] };

      const quotes: FetchedQuote[] = [];
      const seen = new Set<string>();
      for (const item of results as Array<Record<string, unknown>>) {
        const symbol = typeof item?.symbol === 'string' ? item.symbol.toUpperCase() : '';
        const price = item?.regularMarketPrice;
        if (!valid.includes(symbol)) continue;
        if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
          warnings.push(`No usable price for ${symbol}`);
          seen.add(symbol);
          continue;
        }
        seen.add(symbol);
        quotes.push({ ticker: symbol, date: dayOfTime(item.regularMarketTime) ?? today(), close: price });
      }
      for (const t of valid) if (!seen.has(t)) warnings.push(`No quote returned for ${t}`);
      return { quotes, warnings };
    },
  };
}
