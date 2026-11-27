import { describe, expect, it } from 'vitest';

import { buildSuggestion } from './capture-suggestion.js';

// Invented ids. An Open Finance draft already knows its account (the link of the bank account it came from).
const ACC = '00000000-0000-4000-8000-000000000001';
const RULE_ACC = '00000000-0000-4000-8000-000000000002';
const base = { postedAt: new Date('2026-11-25T15:00:00.000Z') };

describe('buildSuggestion: Open Finance drafts', () => {
  it('takes the account from the draft itself, over any rule', () => {
    const suggestion = buildSuggestion(
      { ...base, package: 'open-finance', parsed: { kind: 'PIX_OUT', type: 'EXPENSE', amountCents: 2200, description: 'Pix Exemplo', accountId: ACC } },
      [{ package: 'open-finance', kind: 'PIX_OUT', accountId: RULE_ACC }],
    );
    expect(suggestion).toMatchObject({ accountId: ACC, type: 'EXPENSE', amount: 22, description: 'Pix Exemplo' });
  });

  it('an account written in the reading of a notification app is not trusted (only Open Finance drafts carry one)', () => {
    const suggestion = buildSuggestion(
      { ...base, package: 'com.nu.production', parsed: { kind: 'PIX_OUT', type: 'EXPENSE', amountCents: 2200, accountId: ACC } },
      [{ package: 'com.nu.production', kind: 'PIX_OUT', accountId: RULE_ACC }],
    );
    expect(suggestion.accountId).toBe(RULE_ACC);
  });
});
