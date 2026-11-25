import { CategoryName, CategoryType, TransactionType, getCategoriesByType } from '../../shared/enums/index.js';
import { fromCents, toCents } from './credit-card-invoice-forecast.js';
import { invoicePaymentCardId } from './invoice-payment-link.js';

interface Movement {
  accountId: string | null;
  amount: { toNumber(): number };
  type: string | null;
  categoryName: string | null;
  attachmentUrl: string | null;
  invoicePaymentAccountId?: string | null;
}

/**
 * Debt a card had before the given movements, from its current balance: the balance minus everything the movements
 * did to it (expenses add debt; income and invoice payments remove it). Summed in integer cents, so the result is
 * exact to the cent. Never negative.
 */
export function openingDebtFromMovements(balance: { toNumber(): number }, movements: Movement[], cardId: string): number {
  let netChangeCents = 0;
  for (const t of movements) {
    const cents = toCents(t.amount.toNumber());
    if (invoicePaymentCardId(t) === cardId) {
      netChangeCents -= cents; // Payment decreases debt
    } else if (t.accountId === cardId && t.categoryName) {
      const isIncome =
        t.type === TransactionType.INCOME ||
        (t.type !== TransactionType.EXPENSE && getCategoriesByType(CategoryType.INCOME).includes(t.categoryName as CategoryName));
      netChangeCents += isIncome ? -cents : cents; // Income decreases debt, expense increases it
    }
  }
  return Math.max(0, fromCents(toCents(balance.toNumber()) - netChangeCents));
}
