import { describe, expect, it } from 'vitest';
import { TRANSFER_WINDOW_MS, ownTransferPairs, type TransferCandidate } from './capture-transfer.js';

// Invented data only. A Pix between two accounts of the user is notified as an outflow by one app (or the Google Pay
// e-mail) and as an income with POSSIBLE_OWN_TRANSFER by the other. The pair is offered as one transfer (decided by the
// user on 15/11/2026), never as an income plus an expense.
const GM = 'com.google.android.gm';
const MP = 'com.mercadopago.wallet';
const NU = 'com.nu.production';
const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 10, 15, 10, minute, second));
let seq = 0;
const make = (pkg: string, minute: number, parsed: Record<string, unknown>, over: Partial<TransferCandidate> = {}): TransferCandidate => {
  seq += 1;
  return { id: `t${seq}`, package: pkg, status: 'PENDING', postedAt: at(minute), parsed, ...over };
};
const out = (pkg: string, minute: number, cents = 1000, over: Partial<TransferCandidate> = {}) =>
  make(pkg, minute, { kind: pkg === GM ? 'WALLET_PIX_OUT' : 'PIX_OUT', type: 'EXPENSE', amountCents: cents }, over);
const inc = (pkg: string, minute: number, cents = 1000, over: Partial<TransferCandidate> = {}, warning: string | null = 'POSSIBLE_OWN_TRANSFER') =>
  make(pkg, minute, { kind: 'PIX_IN', type: 'INCOME', amountCents: cents, ...(warning ? { warning } : {}) }, over);

describe('ownTransferPairs', () => {
  it('uses a window of five minutes', () => {
    expect(TRANSFER_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  it('pairs an outflow with an income of the same amount from another app, in either order', () => {
    const o = out(MP, 1);
    const i = inc(NU, 1);
    expect(ownTransferPairs([o, i])).toEqual([{ outId: o.id, inId: i.id }]);
    const i2 = inc(MP, 20);
    const o2 = out(GM, 21); // Pix from the Nubank account made with Google Pay: only the e-mail tells the outflow
    expect(ownTransferPairs([i2, o2])).toEqual([{ outId: o2.id, inId: i2.id }]);
  });

  it('needs the income to be flagged as a possible own transfer', () => {
    expect(ownTransferPairs([out(MP, 1), inc(NU, 1, 1000, {}, null)])).toEqual([]);
  });

  it('leaves alone a different amount, more than five minutes apart, the same app, or a missing side', () => {
    expect(ownTransferPairs([out(MP, 1, 1000), inc(NU, 1, 1001)])).toEqual([]);
    expect(ownTransferPairs([out(MP, 0), inc(NU, 5, 1000, { postedAt: at(5, 1) })])).toEqual([]);
    expect(ownTransferPairs([out(MP, 1), inc(MP, 1)])).toEqual([]);
    expect(ownTransferPairs([out(MP, 1)])).toEqual([]);
    expect(ownTransferPairs([inc(NU, 1)])).toEqual([]);
  });

  it('only pairs pending captures', () => {
    expect(ownTransferPairs([out(MP, 1, 1000, { status: 'CONFIRMED' }), inc(NU, 1)])).toEqual([]);
    expect(ownTransferPairs([out(MP, 1), inc(NU, 1, 1000, { status: 'DISMISSED' })])).toEqual([]);
  });

  it('pairs one to one, closest first', () => {
    const o1 = out(MP, 0);
    const o2 = out(MP, 4);
    const i1 = inc(NU, 1);
    const i2 = inc(NU, 4);
    expect(ownTransferPairs([o1, o2, i1, i2])).toEqual([
      { outId: o1.id, inId: i1.id },
      { outId: o2.id, inId: i2.id },
    ]);
    expect(ownTransferPairs([out(MP, 0), inc(NU, 1), inc(NU, 2)])).toHaveLength(1);
  });

  it('ignores readings without an amount or of another kind', () => {
    expect(ownTransferPairs([out(MP, 1, 0), inc(NU, 1, 0)])).toEqual([]);
    expect(ownTransferPairs([make(MP, 1, { kind: 'CARD_PURCHASE', amountCents: 1000 }), inc(NU, 1)])).toEqual([]);
    expect(ownTransferPairs([make(MP, 1, null as never), inc(NU, 1)])).toEqual([]);
  });
});

describe('ownTransferPairs: Open Finance drafts', () => {
  const OF = 'open-finance';
  it('two Open Finance drafts pair only through the same pairKey (they come from the same app)', () => {
    const o = out(OF, 1, 75000);
    const i = inc(OF, 1, 75000);
    o.parsed = { ...(o.parsed as Record<string, unknown>), pairKey: 'pk-1' };
    i.parsed = { ...(i.parsed as Record<string, unknown>), pairKey: 'pk-1' };
    const other = inc(OF, 1, 75000);
    other.parsed = { ...(other.parsed as Record<string, unknown>), pairKey: 'pk-2' };
    expect(ownTransferPairs([o, other, i])).toEqual([{ outId: o.id, inId: i.id }]);
  });

  it('an Open Finance draft never pairs with a notification of another app', () => {
    const o = out(OF, 1, 75000);
    o.parsed = { ...(o.parsed as Record<string, unknown>), pairKey: 'pk-1' };
    expect(ownTransferPairs([o, inc(NU, 1, 75000)])).toEqual([]);
  });
});
