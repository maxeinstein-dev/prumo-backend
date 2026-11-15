import { describe, expect, it } from 'vitest';
import { DUPLICATE_WINDOW_MS, duplicatesToDismiss, type DuplicateCandidate } from './capture-duplicates.js';

// Invented data only. A Pix made with Google Pay from the Mercado Pago account is notified twice: by the Mercado Pago app
// and by an e-mail (Google Pay's, or Mercado Pago's own). One of the two is dismissed (decided by the user on 15/11/2026):
// the e-mail, unless the e-mail was already confirmed, and then the app notification that came later.
const GM = 'com.google.android.gm';
const MP = 'com.mercadopago.wallet';
const NU = 'com.nu.production';
const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 10, 15, 12, minute, second));
let seq = 0;
const cap = (over: Partial<DuplicateCandidate> & { kind?: string; cents?: number | null }): DuplicateCandidate => {
  seq += 1;
  const { kind = 'PIX_OUT', cents = 1000, ...rest } = over;
  return { id: `c${seq}`, package: MP, status: 'PENDING', postedAt: at(0), parsed: { kind, amountCents: cents }, ...rest };
};
const email = (minute: number, over: Partial<DuplicateCandidate> & { kind?: string; cents?: number | null } = {}) =>
  cap({ package: GM, kind: 'WALLET_PIX_OUT', postedAt: at(minute), ...over });

describe('duplicatesToDismiss', () => {
  it('uses a window of five minutes', () => {
    expect(DUPLICATE_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  it('dismisses the e-mail of the same amount within five minutes of the Mercado Pago outflow, in either order', () => {
    const app = cap({ postedAt: at(0) });
    const after = email(3);
    expect(duplicatesToDismiss([app, after])).toEqual([{ id: after.id, duplicateOf: app.id }]);
    const before = email(0);
    const app2 = cap({ postedAt: at(4, 59) });
    expect(duplicatesToDismiss([before, app2])).toEqual([{ id: before.id, duplicateOf: app2.id }]);
  });

  it('also treats the Mercado Pago e-mail of a Pix sent (PIX_OUT from Gmail) as the e-mail side', () => {
    const app = cap({});
    const mpEmail = email(1, { kind: 'PIX_OUT' });
    expect(duplicatesToDismiss([app, mpEmail])).toEqual([{ id: mpEmail.id, duplicateOf: app.id }]);
  });

  it('only a Mercado Pago app outflow repeats an e-mail: a Pix sent from another app is never a duplicate', () => {
    expect(duplicatesToDismiss([cap({ package: NU }), email(1)])).toEqual([]);
  });

  it('leaves both with a different amount, more than five minutes apart, or no app outflow at all', () => {
    expect(duplicatesToDismiss([cap({}), email(2, { cents: 1001 })])).toEqual([]);
    expect(duplicatesToDismiss([cap({ postedAt: at(0) }), email(5, { postedAt: at(5, 1) })])).toEqual([]);
    expect(duplicatesToDismiss([email(2)])).toEqual([]);
    expect(duplicatesToDismiss([cap({ kind: 'PIX_IN' }), email(1)])).toEqual([]);
  });

  it('pairs one to one, closest first: two Pix of the same amount keep two outflows', () => {
    const app1 = cap({ postedAt: at(0) });
    const app2 = cap({ postedAt: at(3) });
    const e1 = email(1);
    const e2 = email(4);
    const e3 = email(5);
    expect(duplicatesToDismiss([app1, app2, e1, e2, e3])).toEqual([
      { id: e1.id, duplicateOf: app1.id },
      { id: e2.id, duplicateOf: app2.id },
    ]);
  });

  it('when the e-mail was already confirmed, the app notification that arrives later is the duplicate', () => {
    const confirmed = email(0, { status: 'CONFIRMED' });
    const app = cap({ postedAt: at(2) });
    expect(duplicatesToDismiss([confirmed, app])).toEqual([{ id: app.id, duplicateOf: confirmed.id }]);
  });

  it('a confirmed app outflow still takes the pending e-mail; two confirmed or a dismissed side do nothing', () => {
    expect(duplicatesToDismiss([cap({ status: 'CONFIRMED' }), email(1)])).toHaveLength(1);
    expect(duplicatesToDismiss([cap({ status: 'CONFIRMED' }), email(1, { status: 'CONFIRMED' })])).toEqual([]);
    expect(duplicatesToDismiss([cap({ status: 'DISMISSED' }), email(1)])).toEqual([]);
    expect(duplicatesToDismiss([cap({}), email(1, { status: 'DISMISSED' })])).toEqual([]);
  });

  it('never pairs an e-mail with another e-mail, and ignores readings without an amount', () => {
    expect(duplicatesToDismiss([email(0), email(1)])).toEqual([]);
    expect(duplicatesToDismiss([cap({ cents: null }), email(1, { cents: null })])).toEqual([]);
    expect(duplicatesToDismiss([cap({ parsed: null } as never), email(1)])).toEqual([]);
  });
});
