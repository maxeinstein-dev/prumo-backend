import { describe, expect, it } from 'vitest';
import { duplicateEmails, type DuplicateCandidate } from './capture-duplicates.js';

// Invented data only. A Pix made with Google Pay from the Mercado Pago account is notified twice: by the Mercado Pago app
// and by the Google Pay e-mail. The e-mail is the one dismissed (decided by the user on 15/11/2026).
const GM = 'com.google.android.gm';
const MP = 'com.mercadopago.wallet';
const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 10, 15, 12, minute, second));
let seq = 0;
const cap = (over: Partial<DuplicateCandidate> & { kind?: string; cents?: number | null }): DuplicateCandidate => {
  seq += 1;
  const { kind = 'PIX_OUT', cents = 1000, ...rest } = over;
  return { id: `c${seq}`, package: MP, status: 'PENDING', postedAt: at(0), parsed: { kind, amountCents: cents }, ...rest };
};
const email = (minute: number, over: Partial<DuplicateCandidate> & { kind?: string; cents?: number | null } = {}) =>
  cap({ package: GM, kind: 'WALLET_PIX_OUT', postedAt: at(minute), ...over });

describe('duplicateEmails', () => {
  it('pairs the e-mail with the app outflow of the same amount within ten minutes, in either order', () => {
    const app = cap({ postedAt: at(0) });
    const after = email(3);
    const before = email(0, { postedAt: at(0, 0) });
    expect(duplicateEmails([app, after])).toEqual([{ id: after.id, duplicateOf: app.id }]);
    const app2 = cap({ postedAt: at(9, 59) });
    expect(duplicateEmails([before, app2])).toEqual([{ id: before.id, duplicateOf: app2.id }]);
  });

  it('also treats the Mercado Pago e-mail of a Pix sent (PIX_OUT from Gmail) as the e-mail side', () => {
    const app = cap({});
    const mpEmail = email(1, { kind: 'PIX_OUT' });
    expect(duplicateEmails([app, mpEmail])).toEqual([{ id: mpEmail.id, duplicateOf: app.id }]);
  });

  it('leaves the e-mail alone with a different amount, more than ten minutes away, or no app outflow at all', () => {
    expect(duplicateEmails([cap({}), email(2, { cents: 1001 })])).toEqual([]);
    expect(duplicateEmails([cap({ postedAt: at(0) }), email(10, { postedAt: at(10, 1) })])).toEqual([]);
    expect(duplicateEmails([email(2)])).toEqual([]);
    expect(duplicateEmails([cap({ kind: 'PIX_IN' }), email(1)])).toEqual([]);
  });

  it('pairs one to one, closest first: two Pix of the same amount keep two outflows', () => {
    const app1 = cap({ postedAt: at(0) });
    const app2 = cap({ postedAt: at(6) });
    const e1 = email(1);
    const e2 = email(7);
    const e3 = email(8);
    expect(duplicateEmails([app1, app2, e1, e2, e3])).toEqual([
      { id: e1.id, duplicateOf: app1.id },
      { id: e2.id, duplicateOf: app2.id },
    ]);
  });

  it('only dismisses a pending e-mail; a confirmed app outflow still counts, a dismissed one does not', () => {
    expect(duplicateEmails([cap({ status: 'CONFIRMED' }), email(1)])).toHaveLength(1);
    expect(duplicateEmails([cap({ status: 'DISMISSED' }), email(1)])).toEqual([]);
    expect(duplicateEmails([cap({}), email(1, { status: 'CONFIRMED' })])).toEqual([]);
  });

  it('never pairs an e-mail with another e-mail, and ignores readings without an amount', () => {
    expect(duplicateEmails([email(0), email(1)])).toEqual([]);
    expect(duplicateEmails([cap({ cents: null }), email(1, { cents: null })])).toEqual([]);
    expect(duplicateEmails([cap({ parsed: null } as never), email(1)])).toEqual([]);
  });
});
