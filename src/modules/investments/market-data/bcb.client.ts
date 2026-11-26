/**
 * Client of the Banco Central SGS series (P21 L2), no key needed.
 *
 *   CDI   = series 12, percent per day (one row per business day)
 *   SELIC = series 11, percent per day
 *   IPCA  = series 433, percent per month; the date of a row is moved to the 1st of its reference month
 *
 * Like the brapi client: never throws for a network, timeout, HTTP or parsing problem; it returns warnings and the caller
 * keeps what it has stored. `fetch` is injectable.
 */

export type MarketIndexName = 'CDI' | 'SELIC' | 'IPCA';

export interface FetchedRate {
  /** 'YYYY-MM-DD' */
  date: string;
  /** CDI/SELIC: percent per day. IPCA: percent per month. */
  value: number;
}

export interface SeriesResult {
  rates: FetchedRate[];
  warnings: string[];
}

export interface BcbClient {
  fetchSeries(index: MarketIndexName, from: string, to: string): Promise<SeriesResult>;
}

/**
 * The SGS answers 404 with "Value(s) not found" when the period has no rate yet (the CDI of a day is published on the next
 * business day, so the early run often asks only for days still unpublished). That is "nothing new", not a failure; any
 * other 404 is still a warning.
 */
async function isNothingPublished(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { erro?: { detail?: unknown } } | null;
    return typeof body?.erro?.detail === 'string' && body.erro.detail.includes('Value(s) not found');
  } catch {
    return false;
  }
}

export interface BcbOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

export const SGS_SERIES: Record<MarketIndexName, number> = { CDI: 12, SELIC: 11, IPCA: 433 };

const toBr = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

function parseBrDay(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!m) return null;
  const [, d, mo, y] = m as unknown as [string, string, string, string];
  const parsed = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (parsed.getUTCFullYear() !== Number(y) || parsed.getUTCMonth() !== Number(mo) - 1 || parsed.getUTCDate() !== Number(d)) return null;
  return `${y}-${mo}-${d}`;
}

export function createBcbClient(options: BcbOptions = {}): BcbClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const baseUrl = options.baseUrl ?? 'https://api.bcb.gov.br/dados/serie';

  return {
    async fetchSeries(index, from, to) {
      const url = `${baseUrl}/bcdata.sgs.${SGS_SERIES[index]}/dados?formato=json&dataInicial=${toBr(from)}&dataFinal=${toBr(to)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let body: unknown;
      try {
        const response = await doFetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
        if (response.status === 404 && (await isNothingPublished(response))) return { rates: [], warnings: [] };
        if (!response.ok) return { rates: [], warnings: [`Banco Central answered HTTP ${response.status} for ${index}: rates not updated`] };
        body = await response.json();
      } catch {
        const reason = controller.signal.aborted ? 'timeout' : 'network error';
        return { rates: [], warnings: [`Banco Central unavailable (${reason}) for ${index}: rates not updated`] };
      } finally {
        clearTimeout(timer);
      }
      if (!Array.isArray(body)) return { rates: [], warnings: [`Banco Central answered in an unexpected format for ${index}: rates not updated`] };

      const rates: FetchedRate[] = [];
      let skipped = 0;
      for (const row of body as Array<Record<string, unknown>>) {
        const day = parseBrDay(row?.data);
        const raw = typeof row?.valor === 'string' ? row.valor.trim() : '';
        const value = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
        if (!day || !Number.isFinite(value)) {
          skipped += 1;
          continue;
        }
        rates.push({ date: index === 'IPCA' ? `${day.slice(0, 7)}-01` : day, value });
      }
      const warnings = skipped > 0 ? [`Ignored ${skipped} malformed row(s) of the ${index} series`] : [];
      return { rates, warnings };
    },
  };
}
