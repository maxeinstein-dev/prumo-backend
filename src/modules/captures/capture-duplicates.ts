import { pairClosest, readingOf, type PairCandidate } from './capture-pairing.js';

/**
 * One Pix, two notifications: a Pix made with Google Pay from the Mercado Pago account is notified by the Mercado Pago
 * app and by an e-mail (Google Pay's, or Mercado Pago's own e-mail of a Pix sent). One of them is dismissed, with
 * "restore" still there (decided by the user on 15/11/2026): the e-mail, unless the e-mail was already confirmed, and
 * then the app notification that came later (the Pix is already in the books). Pure: the service reads and writes.
 *
 * An e-mail (Gmail, a Pix outflow) pairs with a Mercado Pago app outflow (PIX_OUT) of the same amount posted at most five
 * minutes apart, before or after: only that app has a twin e-mail, so a Pix sent from another app is never taken for
 * one, and the short window keeps two real Pix of the same amount apart. One to one, the closest pair first.
 */

export const GMAIL_PACKAGE = 'com.google.android.gm';
export const MERCADO_PAGO_PACKAGE = 'com.mercadopago.wallet';
export const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

const EMAIL_KINDS: ReadonlySet<string> = new Set(['PIX_OUT', 'WALLET_PIX_OUT']);
const LIVE: ReadonlySet<string> = new Set(['PENDING', 'CONFIRMED']);

export type DuplicateCandidate = PairCandidate;

export interface DuplicateToDismiss {
  /** The capture to dismiss. */
  id: string;
  /** The capture it repeats, which stays. */
  duplicateOf: string;
}

export function isEmailOutflow(c: Pick<PairCandidate, 'package' | 'parsed'>): boolean {
  const r = readingOf(c.parsed);
  return c.package === GMAIL_PACKAGE && !!r && EMAIL_KINDS.has(r.kind);
}

export function isAppOutflow(c: Pick<PairCandidate, 'package' | 'parsed'>): boolean {
  const r = readingOf(c.parsed);
  return c.package === MERCADO_PAGO_PACKAGE && !!r && r.kind === 'PIX_OUT';
}

export function duplicatesToDismiss(candidates: readonly DuplicateCandidate[]): DuplicateToDismiss[] {
  const emails = candidates.filter((c) => LIVE.has(c.status) && isEmailOutflow(c));
  const apps = candidates.filter((c) => LIVE.has(c.status) && isAppOutflow(c));
  const out: DuplicateToDismiss[] = [];
  // Two confirmed sides are both in the books already, and nothing pending is left to dismiss.
  const pairs = pairClosest(emails, apps, DUPLICATE_WINDOW_MS, (email, app) => email.status === 'PENDING' || app.status === 'PENDING');
  for (const { left: email, right: app } of pairs) {
    if (email.status === 'PENDING') out.push({ id: email.id, duplicateOf: app.id });
    else out.push({ id: app.id, duplicateOf: email.id });
  }
  return out;
}
