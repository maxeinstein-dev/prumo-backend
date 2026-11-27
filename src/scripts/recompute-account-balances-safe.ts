#!/usr/bin/env tsx
/**
 * Fix balances ONLY for accounts affected by fix_income migration.
 * 
 * This script:
 * 1. Finds accounts that have INCOME transactions with income categories (these may have been corrected)
 * 2. Recalculates balances ONLY for those accounts from their transaction history
 * 3. Leaves all other accounts completely untouched
 *
 * Usage:
 *   npm run script:recompute-balances
 *   npx tsx src/scripts/recompute-account-balances-safe.ts
 */

import 'dotenv/config';
import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../shared/db/prisma.js';
import { AccountType, TransactionType } from '../shared/enums/index.js';
import { recalculateCreditCardLimit } from '../shared/services/balance.service.js';
import { computeAccountBalances, recomputeTransactionsWhere } from './account-balance-recompute.js';

async function main() {
  console.log('🔍 Finding accounts affected by fix_income migration...');

  const incomeCategories = ['SALARY', 'FREELANCE', 'INVESTMENTS', 'SALES', 'RENTAL_INCOME', 'OTHER_INCOME'];
  
  // Get custom income categories
  const customIncomeCategories = await prisma.category.findMany({
    where: { type: 'INCOME' },
    select: { id: true },
  });
  
  const customCategoryIds = customIncomeCategories.map(c => `CUSTOM:${c.id}`);
  
  // Find accounts that have INCOME transactions with income categories
  // These are the accounts that may have been affected by the migration
  const affectedTransactions = await prisma.transaction.findMany({
    where: {
      type: TransactionType.INCOME,
      paid: { not: false }, // paid = true or null
      accountId: { not: null },
      OR: [
        { categoryName: { in: incomeCategories } },
        { categoryName: { in: customCategoryIds } },
      ],
    },
    select: {
      accountId: true,
    },
    distinct: ['accountId'],
  });

  if (affectedTransactions.length === 0) {
    console.log('✅ No affected accounts found. No balance adjustments needed.');
    return;
  }

  const affectedAccountIds = affectedTransactions
    .map(t => t.accountId)
    .filter((id): id is string => id !== null);

  console.log(`📊 Found ${affectedAccountIds.length} affected accounts`);

  // Get all transactions that move the balances of the affected accounts (incoming transfers included)
  const allTransactions = await prisma.transaction.findMany({
    where: recomputeTransactionsWhere(affectedAccountIds),
    select: {
      id: true,
      type: true,
      amount: true,
      paid: true,
      accountId: true,
      fromAccountId: true,
      toAccountId: true,
      relatedEntityId: true,
    },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  });

  // Get account details
  const accounts = await prisma.account.findMany({
    where: { id: { in: affectedAccountIds } },
    select: {
      id: true,
      name: true,
      type: true,
      creditLimit: true,
    },
  });

  const balances = computeAccountBalances(
    accounts.map(a => ({ id: a.id, type: a.type, creditLimit: a.creditLimit?.toNumber() ?? 0 })),
    allTransactions.map(t => ({ ...t, amount: t.amount.toNumber() })),
    affectedAccountIds
  );

  console.log(`🔄 Recalculating balances for ${accounts.length} affected accounts...`);

  await prisma.$transaction(async (tx) => {
    for (const acc of accounts) {
      const b = balances.get(acc.id);
      if (!b) continue;

      if (acc.type === AccountType.CREDIT) {
        await tx.account.update({
          where: { id: acc.id },
          data: {
            balance: new Prisma.Decimal(b.balance),
            totalBalance: new Prisma.Decimal(b.totalBalance),
            availableBalance: new Prisma.Decimal(b.availableBalance),
            allocatedBalance: new Prisma.Decimal(b.allocatedBalance),
            totalLimit: new Prisma.Decimal(b.totalLimit ?? 0),
          },
        });
        await recalculateCreditCardLimit(tx, acc.id);
      } else {
        if (b.totalBalance - b.allocatedBalance < 0) {
          console.warn(
            `⚠️  Account "${acc.name}" (${acc.id}): available would be ${b.totalBalance - b.allocatedBalance}. Clamping to 0.`
          );
        }

        await tx.account.update({
          where: { id: acc.id },
          data: {
            balance: new Prisma.Decimal(b.balance),
            totalBalance: new Prisma.Decimal(b.totalBalance),
            availableBalance: new Prisma.Decimal(b.availableBalance),
            allocatedBalance: new Prisma.Decimal(b.allocatedBalance),
          },
        });
      }
    }
  });

  console.log('✅ Balance recalculation completed successfully.');
  console.log(`📝 Recalculated ${accounts.length} affected accounts. All other accounts were left untouched.`);
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
