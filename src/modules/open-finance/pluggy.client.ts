/**
 * Client of the Pluggy API (P25 L1), read only, for the user's own accounts connected through Meu Pluggy.
 *
 * - POST /auth trades PLUGGY_CLIENT_ID/PLUGGY_CLIENT_SECRET for an API key ONCE per client instance (one instance per
 *   run: one request, one job execution). The key lasts 2 hours, longer than any run. A failed trade is not retried by
 *   the same instance.
 * - The API key goes only in the X-API-KEY header. The secret and the key are never put in a URL, a log or an error:
 *   errors carry a fixed text, a kind and, at most, the HTTP status.
 * - GET /accounts?itemId= pages by page/totalPages; GET /v2/transactions?accountId=&dateFrom=&dateTo= pages by the
 *   `next` cursor (the older GET /transactions is deprecated by Pluggy, removal announced for 2026-12-31).
 *
 * `fetch` is injectable so tests never touch the network.
 * Docs: https://docs.pluggy.ai/docs/authentication, https://docs.pluggy.ai/reference/accounts-list,
 * https://docs.pluggy.ai/reference/transaction/transactions-list-by-cursor
 */

export type PluggyErrorKind = 'not_configured' | 'auth' | 'http' | 'network' | 'invalid_response';

const MESSAGES: Record<PluggyErrorKind, string> = {
  not_configured: 'Open Finance (Pluggy) is not configured',
  auth: 'Pluggy rejected the credentials',
  http: 'Pluggy answered with an error',
  network: 'Pluggy could not be reached',
  invalid_response: 'Pluggy sent an unexpected answer',
};

export class PluggyError extends Error {
  readonly kind: PluggyErrorKind;
  readonly status?: number;

  constructor(kind: PluggyErrorKind, status?: number) {
    super(status ? `${MESSAGES[kind]} (HTTP ${status})` : MESSAGES[kind]);
    this.name = 'PluggyError';
    this.kind = kind;
    this.status = status;
  }
}

export interface PluggyAccount {
  id: string;
  itemId: string;
  /** 'BANK' | 'CREDIT' */
  type: string;
  /** e.g. 'CHECKING_ACCOUNT', 'SAVINGS_ACCOUNT', 'CREDIT_CARD' */
  subtype: string | null;
  name: string;
  marketingName: string | null;
  number: string | null;
  /** As Pluggy sends it; no conversion. */
  balance: number | null;
  currencyCode: string;
}

export interface PluggyTransaction {
  id: string;
  accountId: string;
  /** 'YYYY-MM-DD' (the date part Pluggy sends). */
  date: string;
  description: string;
  /** As Pluggy sends it: negative for DEBIT in the documented examples. */
  amount: number;
  /** 'DEBIT' | 'CREDIT' */
  type: string;
  /** 'POSTED' | 'PENDING' */
  status: string | null;
}

export interface PluggyItem {
  id: string;
  /** e.g. 'UPDATED', 'UPDATING', 'OUTDATED', 'LOGIN_ERROR', 'WAITING_USER_INPUT' */
  status: string;
  /** e.g. 'SUCCESS', 'USER_AUTHORIZATION_EXPIRED' */
  executionStatus: string | null;
  /** End of the Open Finance consent (Meu Pluggy: one year), when Pluggy sends it. */
  consentExpiresAt: string | null;
  connectorName: string | null;
}

export interface PluggyInvestment {
  id: string;
  name: string;
  /** Ticker for exchange-traded assets (or a fund's CNPJ); null when Pluggy sends none. */
  code: string | null;
  /** 'EQUITY' | 'ETF' | 'FIXED_INCOME' | 'MUTUAL_FUND' | 'COE' | 'SECURITY' | 'OTHER' */
  type: string;
  /** e.g. 'STOCK', 'REAL_ESTATE_FUND', 'BDR', 'LCA', 'CDB', 'TREASURY' */
  subtype: string | null;
  /** Current net value of the position, in reais (Pluggy's `balance`). */
  balance: number;
  quantity: number | null;
  /** Unit value on `date`. */
  value: number | null;
  /** 'YYYY-MM-DD' of the value, when Pluggy sends it. */
  date: string | null;
  dueDate: string | null;
  /** 'ACTIVE' | 'PENDING' | 'TOTAL_WITHDRAWAL' */
  status: string | null;
}

export interface PluggyBill {
  id: string;
  /** 'YYYY-MM-DD' */
  dueDate: string;
  /** 'YYYY-MM-DD', when the bank sends it. */
  closingDate: string | null;
  /** Reais. */
  totalAmount: number;
}

export interface PluggyCard {
  id: string;
  /** Reais, as Pluggy sends it (its meaning for cards is not documented: compared only as information). */
  balance: number | null;
  closeDate: string | null;
  dueDate: string | null;
  creditLimit: number | null;
  availableCreditLimit: number | null;
  minimumPayment: number | null;
}

export interface PluggyClient {
  /** GET /bills?accountId=: the closed bills of a card account (Open Finance connections). */
  listBills(accountId: string): Promise<PluggyBill[]>;
  /** GET /accounts?itemId=&type=CREDIT: the card accounts of an item with their credit data. */
  listCards(itemId: string): Promise<PluggyCard[]>;
  /** GET /investments?itemId=: the investments of a connection (a broker's portfolio). */
  listInvestments(itemId: string): Promise<PluggyInvestment[]>;
  /** GET /items/:id: the status of a connection (an expired authorization reads as empty lists, not as an error). */
  getItem(itemId: string): Promise<PluggyItem>;
  /** Trades the keys for an API key: 'refused' when Pluggy turns them down (e.g. CLIENT_SECRET_EXPIRED). */
  checkCredentials(): Promise<'ok' | 'refused'>;
  listAccounts(itemId: string): Promise<PluggyAccount[]>;
  /** `from` and `to` are 'YYYY-MM-DD', both inclusive. */
  listTransactions(accountId: string, range: { from: string; to: string }): Promise<PluggyTransaction[]>;
}

export interface PluggyOptions {
  clientId: string | undefined;
  clientSecret: string | undefined;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  /** Safety cap on pages of one listing; a cursor that never ends fails instead of looping. */
  maxPages?: number;
}

type Json = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toAccount(raw: Json): PluggyAccount {
  const id = str(raw.id);
  const itemId = str(raw.itemId);
  const type = str(raw.type);
  if (!id || !itemId || !type) throw new PluggyError('invalid_response');
  return {
    id,
    itemId,
    type,
    subtype: str(raw.subtype),
    name: str(raw.name) ?? '',
    marketingName: str(raw.marketingName),
    number: str(raw.number),
    balance: num(raw.balance),
    currencyCode: str(raw.currencyCode) ?? 'BRL',
  };
}

const dayOf = (value: unknown): string | null => {
  const text = str(value);
  return text && /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
};

function toInvestment(raw: Json): PluggyInvestment {
  const id = str(raw.id);
  const type = str(raw.type);
  const balance = num(raw.balance);
  if (!id || !type || balance === null) throw new PluggyError('invalid_response');
  return {
    id,
    name: str(raw.name) ?? '',
    code: str(raw.code),
    type,
    subtype: str(raw.subtype),
    balance,
    quantity: num(raw.quantity),
    value: num(raw.value),
    date: dayOf(raw.date),
    dueDate: dayOf(raw.dueDate),
    status: str(raw.status),
  };
}

function toBill(raw: Json): PluggyBill {
  const id = str(raw.id);
  const dueDate = dayOf(raw.dueDate);
  const totalAmount = num(raw.totalAmount);
  if (!id || !dueDate || totalAmount === null) throw new PluggyError('invalid_response');
  return { id, dueDate, closingDate: dayOf(raw.billClosingDate), totalAmount };
}

function toCard(raw: Json): PluggyCard {
  const id = str(raw.id);
  if (!id) throw new PluggyError('invalid_response');
  const credit = (raw.creditData ?? {}) as Json;
  return {
    id,
    balance: num(raw.balance),
    closeDate: dayOf(credit.balanceCloseDate),
    dueDate: dayOf(credit.balanceDueDate),
    creditLimit: num(credit.creditLimit),
    availableCreditLimit: num(credit.availableCreditLimit),
    minimumPayment: num(credit.minimumPayment),
  };
}

function toTransaction(raw: Json): PluggyTransaction {
  const id = str(raw.id);
  const accountId = str(raw.accountId);
  const date = str(raw.date);
  const amount = num(raw.amount);
  const type = str(raw.type);
  if (!id || !accountId || !date || !/^\d{4}-\d{2}-\d{2}/.test(date) || amount === null || !type) {
    throw new PluggyError('invalid_response');
  }
  return {
    id,
    accountId,
    date: date.slice(0, 10),
    description: str(raw.description) ?? '',
    amount,
    type,
    status: str(raw.status),
  };
}

function results(body: unknown): Json[] {
  const list = (body as Json | null)?.results;
  if (!Array.isArray(list)) throw new PluggyError('invalid_response');
  return list as Json[];
}

export function createPluggyClient(options: PluggyOptions): PluggyClient {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? 'https://api.pluggy.ai').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxPages = options.maxPages ?? 50;
  const clientId = options.clientId?.trim();
  const clientSecret = options.clientSecret?.trim();

  let apiKey: Promise<string> | null = null;

  async function request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } catch {
      throw new PluggyError('network');
    } finally {
      clearTimeout(timer);
    }
  }

  async function readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new PluggyError('invalid_response');
    }
  }

  async function authenticate(): Promise<string> {
    if (!clientId || !clientSecret) throw new PluggyError('not_configured');
    const response = await request(`${baseUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new PluggyError('auth', response.status);
    }
    if (!response.ok) throw new PluggyError('http', response.status);
    const key = str(((await readJson(response)) as Json | null)?.apiKey);
    if (!key) throw new PluggyError('invalid_response');
    return key;
  }

  function getApiKey(): Promise<string> {
    // Kept even when it fails: the same run never asks again with keys that were just refused.
    apiKey ??= authenticate();
    return apiKey;
  }

  async function get(pathAndQuery: string): Promise<unknown> {
    const key = await getApiKey();
    const response = await request(`${baseUrl}${pathAndQuery}`, {
      method: 'GET',
      headers: { 'X-API-KEY': key, Accept: 'application/json' },
    });
    if (response.status === 401 || response.status === 403) throw new PluggyError('auth', response.status);
    if (!response.ok) throw new PluggyError('http', response.status);
    return readJson(response);
  }

  return {
    async checkCredentials() {
      try {
        await getApiKey();
        return 'ok';
      } catch (error) {
        if (error instanceof PluggyError && error.kind === 'auth') return 'refused';
        throw error;
      }
    },

    async getItem(itemId) {
      const body = (await get(`/items/${encodeURIComponent(itemId)}`)) as Json | null;
      const id = str(body?.id);
      const status = str(body?.status);
      if (!id || !status) throw new PluggyError('invalid_response');
      return {
        id,
        status,
        executionStatus: str(body?.executionStatus),
        consentExpiresAt: str(body?.consentExpiresAt),
        connectorName: str((body?.connector as Json | undefined)?.name),
      };
    },

    async listBills(accountId) {
      const bills: PluggyBill[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const query = new URLSearchParams({ accountId, page: String(page), pageSize: '500' });
        const body = await get(`/bills?${query}`);
        bills.push(...results(body).map(toBill));
        const totalPages = num((body as Json).totalPages) ?? 1;
        if (page >= totalPages) return bills;
      }
      throw new PluggyError('invalid_response');
    },

    async listCards(itemId) {
      const query = new URLSearchParams({ itemId, type: 'CREDIT', page: '1', pageSize: '500' });
      return results(await get(`/accounts?${query}`)).map(toCard);
    },

    async listInvestments(itemId) {
      const investments: PluggyInvestment[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const query = new URLSearchParams({ itemId, page: String(page), pageSize: '500' });
        const body = await get(`/investments?${query}`);
        investments.push(...results(body).map(toInvestment));
        const totalPages = num((body as Json).totalPages) ?? 1;
        if (page >= totalPages) return investments;
      }
      throw new PluggyError('invalid_response');
    },

    async listAccounts(itemId) {
      const accounts: PluggyAccount[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const query = new URLSearchParams({ itemId, page: String(page), pageSize: '500' });
        const body = await get(`/accounts?${query}`);
        accounts.push(...results(body).map(toAccount));
        const totalPages = num((body as Json).totalPages) ?? 1;
        if (page >= totalPages) return accounts;
      }
      throw new PluggyError('invalid_response');
    },

    async listTransactions(accountId, range) {
      const transactions: PluggyTransaction[] = [];
      const first = new URLSearchParams({ accountId, dateFrom: range.from, dateTo: range.to });
      let path = `/v2/transactions?${first}`;
      for (let page = 1; page <= maxPages; page++) {
        const body = await get(path);
        transactions.push(...results(body).map(toTransaction));
        const next = str((body as Json).next);
        if (!next) return transactions;
        // `next` is the query string of the next page ("?accountId=...&after=..."), appended to the path as is.
        if (!next.startsWith('?')) throw new PluggyError('invalid_response');
        path = `/v2/transactions${next}`;
      }
      throw new PluggyError('invalid_response');
    },
  };
}
