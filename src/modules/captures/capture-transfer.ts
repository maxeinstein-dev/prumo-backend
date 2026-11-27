import { pairClosest, readingOf, type PairCandidate } from './capture-pairing.js';
import { OPEN_FINANCE_PACKAGE } from './open-finance-package.js';

/**
 * A Pix between two accounts of the user arrives as an outflow (an app notification or the Google Pay e-mail) and as an
 * income flagged POSSIBLE_OWN_TRANSFER (the other app). The two are offered together as one transfer, confirmed in one
 * tap or dismissed together (decided by the user on 15/11/2026): never an income plus an expense, which would inflate
 * the balance. Read-only: nothing is written until the user confirms (captures.service, confirmTransferPair).
 *
 * Both pending, the same amount, from two different apps, posted at most five minutes apart. One to one, the closest
 * pair first.
 */

export const TRANSFER_WINDOW_MS = 5 * 60 * 1000;

const OUT_KINDS: ReadonlySet<string> = new Set(['PIX_OUT', 'WALLET_PIX_OUT']);

export type TransferCandidate = PairCandidate;

export interface TransferPair {
  outId: string;
  inId: string;
}

export function isTransferOut(c: Pick<PairCandidate, 'status' | 'parsed'>): boolean {
  const r = readingOf(c.parsed);
  return c.status === 'PENDING' && !!r && OUT_KINDS.has(r.kind);
}

export function isTransferIn(c: Pick<PairCandidate, 'status' | 'parsed'>): boolean {
  const r = readingOf(c.parsed);
  return c.status === 'PENDING' && !!r && r.kind === 'PIX_IN' && r.warning === 'POSSIBLE_OWN_TRANSFER';
}

function pairKey(c: TransferCandidate): string | null {
  const key = (c.parsed as Record<string, unknown> | null | undefined)?.pairKey;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/** Notifications pair across two apps; Open Finance drafts (one source for both banks) only through their pairKey. */
function canPair(o: TransferCandidate, i: TransferCandidate): boolean {
  if (o.package === OPEN_FINANCE_PACKAGE || i.package === OPEN_FINANCE_PACKAGE) {
    return o.package === i.package && pairKey(o) !== null && pairKey(o) === pairKey(i);
  }
  return o.package !== i.package;
}

export function ownTransferPairs(candidates: readonly TransferCandidate[]): TransferPair[] {
  const outs = candidates.filter(isTransferOut);
  const ins = candidates.filter(isTransferIn);
  return pairClosest(outs, ins, TRANSFER_WINDOW_MS, canPair)
    .map(({ left, right }) => ({ outId: left.id, inId: right.id }));
}
