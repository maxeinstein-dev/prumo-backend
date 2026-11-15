/**
 * One Pix, two notifications: a Pix made with Google Pay from the Mercado Pago account is notified by the Mercado Pago
 * app and by an e-mail (Google Pay's, or Mercado Pago's own e-mail of a Pix sent). The e-mail is the duplicate and is
 * dismissed, with "restore" still there (decided by the user on 15/11/2026). Pure: the service reads and writes.
 *
 * An e-mail (Gmail, a Pix outflow, still PENDING) pairs with an app outflow (another package, PIX_OUT, not dismissed)
 * of the same amount posted at most ten minutes apart, before or after. One to one, the closest pair first, so two Pix
 * of the same amount in the same minutes keep two outflows.
 */

export const GMAIL_PACKAGE = 'com.google.android.gm';
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

const EMAIL_KINDS: ReadonlySet<string> = new Set(['PIX_OUT', 'WALLET_PIX_OUT']);
const GONE: ReadonlySet<string> = new Set(['DISMISSED', 'IGNORED']);

export interface DuplicateCandidate {
  id: string;
  package: string;
  status: string;
  postedAt: Date;
  parsed: unknown;
}

export interface DuplicateEmail {
  id: string;
  duplicateOf: string;
}

function reading(parsed: unknown): { kind: string; cents: number } | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const { kind, amountCents } = parsed as { kind?: unknown; amountCents?: unknown };
  if (typeof kind !== 'string' || typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents <= 0) return null;
  return { kind, cents: amountCents };
}

export function isEmailOutflow(c: Pick<DuplicateCandidate, 'package' | 'parsed'>): boolean {
  const r = reading(c.parsed);
  return c.package === GMAIL_PACKAGE && !!r && EMAIL_KINDS.has(r.kind);
}

export function isAppOutflow(c: Pick<DuplicateCandidate, 'package' | 'parsed'>): boolean {
  const r = reading(c.parsed);
  return c.package !== GMAIL_PACKAGE && !!r && r.kind === 'PIX_OUT';
}

export function duplicateEmails(candidates: readonly DuplicateCandidate[]): DuplicateEmail[] {
  const emails = candidates.filter((c) => c.status === 'PENDING' && isEmailOutflow(c));
  const apps = candidates.filter((c) => !GONE.has(c.status) && isAppOutflow(c));
  const pairs: { email: DuplicateCandidate; app: DuplicateCandidate; gap: number }[] = [];
  for (const email of emails) {
    const cents = reading(email.parsed)!.cents;
    for (const app of apps) {
      if (reading(app.parsed)!.cents !== cents) continue;
      const gap = Math.abs(email.postedAt.getTime() - app.postedAt.getTime());
      if (gap <= DUPLICATE_WINDOW_MS) pairs.push({ email, app, gap });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap || a.email.postedAt.getTime() - b.email.postedAt.getTime() || a.email.id.localeCompare(b.email.id));
  const usedEmails = new Set<string>();
  const usedApps = new Set<string>();
  const chosen: { email: DuplicateCandidate; app: DuplicateCandidate }[] = [];
  for (const pair of pairs) {
    if (usedEmails.has(pair.email.id) || usedApps.has(pair.app.id)) continue;
    usedEmails.add(pair.email.id);
    usedApps.add(pair.app.id);
    chosen.push(pair);
  }
  return chosen
    .sort((a, b) => a.email.postedAt.getTime() - b.email.postedAt.getTime() || a.email.id.localeCompare(b.email.id))
    .map(({ email, app }) => ({ id: email.id, duplicateOf: app.id }));
}
