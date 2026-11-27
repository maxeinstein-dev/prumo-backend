import { describe, expect, it } from 'vitest';
import { AccountType, TransactionType } from '../shared/enums/index.js';
import {
  computeAccountBalances,
  recomputeTransactionsWhere,
  type RecomputeAccount,
  type RecomputeTransaction,
} from './account-balance-recompute.js';

const BANK = 'acc-bank';
const WALLET = 'acc-wallet';
const CARD = 'acc-card';

const accounts: RecomputeAccount[] = [
  { id: BANK, type: AccountType.CHECKING, creditLimit: 0 },
  { id: WALLET, type: AccountType.CASH, creditLimit: 0 },
  { id: CARD, type: AccountType.CREDIT, creditLimit: 1000 },
];

function tx(partial: Partial<RecomputeTransaction> & Pick<RecomputeTransaction, 'type' | 'amount'>): RecomputeTransaction {
  return {
    paid: true,
    accountId: null,
    fromAccountId: null,
    toAccountId: null,
    relatedEntityId: null,
    ...partial,
  };
}

describe('computeAccountBalances', () => {
  it('conta com despesa e transferência de entrada: o total inclui a transferência, como faz applyTransfer', () => {
    const result = computeAccountBalances(
      accounts,
      [
        tx({ type: TransactionType.EXPENSE, amount: 40, accountId: WALLET }),
        // Transferências são gravadas com accountId = origem.
        tx({ type: TransactionType.TRANSFER, amount: 100, accountId: BANK, fromAccountId: BANK, toAccountId: WALLET }),
      ],
      [BANK, WALLET]
    );

    expect(result.get(WALLET)).toMatchObject({ totalBalance: 60, availableBalance: 60, allocatedBalance: 0, balance: 60 });
    expect(result.get(BANK)).toMatchObject({ totalBalance: -100, balance: -100 });
  });

  it('total = receitas pagas − despesas pagas + entradas − saídas; disponível = total − alocado', () => {
    const result = computeAccountBalances(
      accounts,
      [
        tx({ type: TransactionType.INCOME, amount: 500, accountId: BANK }),
        tx({ type: TransactionType.EXPENSE, amount: 80, accountId: BANK }),
        tx({ type: TransactionType.EXPENSE, amount: 999, accountId: BANK, paid: false }),
        tx({ type: TransactionType.TRANSFER, amount: 120, accountId: BANK, fromAccountId: BANK, toAccountId: WALLET }),
        tx({ type: TransactionType.TRANSFER, amount: 30, accountId: WALLET, fromAccountId: WALLET, toAccountId: BANK }),
        tx({ type: TransactionType.ALLOCATION, amount: 50, accountId: BANK, relatedEntityId: CARD }),
      ],
      [BANK, WALLET]
    );

    // 500 − 80 − 120 + 30 = 330
    expect(result.get(BANK)).toEqual({ balance: 330, totalBalance: 330, availableBalance: 280, allocatedBalance: 50 });
    // +120 − 30 = 90
    expect(result.get(WALLET)).toEqual({ balance: 90, totalBalance: 90, availableBalance: 90, allocatedBalance: 0 });
  });

  it('cartão de crédito continua como antes: fatura no total, disponível e alocado zerados, limite com alocações', () => {
    const result = computeAccountBalances(
      accounts,
      [
        tx({ type: TransactionType.EXPENSE, amount: 70, accountId: CARD }),
        tx({ type: TransactionType.INCOME, amount: 20, accountId: CARD }),
        tx({ type: TransactionType.ALLOCATION, amount: 50, accountId: BANK, relatedEntityId: CARD }),
      ],
      [BANK, CARD]
    );

    expect(result.get(CARD)).toEqual({
      balance: 50,
      totalBalance: 50,
      availableBalance: 0,
      allocatedBalance: 0,
      totalLimit: 1050,
    });
  });

  it('não mexe em conta fora da lista de afetadas', () => {
    const result = computeAccountBalances(
      accounts,
      [tx({ type: TransactionType.TRANSFER, amount: 10, accountId: BANK, fromAccountId: BANK, toAccountId: WALLET })],
      [WALLET]
    );

    expect(result.has(BANK)).toBe(false);
    expect(result.get(WALLET)).toMatchObject({ totalBalance: 10 });
  });
});

describe('recomputeTransactionsWhere', () => {
  it('busca também as transferências que entram na conta afetada (accountId é a origem)', () => {
    const where = recomputeTransactionsWhere([WALLET]);

    expect(where.OR).toEqual(
      expect.arrayContaining([
        { accountId: { in: [WALLET] } },
        { toAccountId: { in: [WALLET] } },
        { relatedEntityId: { in: [WALLET] } },
      ])
    );
  });
});
