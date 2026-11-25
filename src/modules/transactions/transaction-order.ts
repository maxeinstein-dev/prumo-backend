import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Order of every cursor-paginated transaction listing. Cursor pagination needs a total order: `date` is a day
 * and many rows share it (an import dates a whole month on day 01), so `createdAt` and finally the unique `id`
 * break the ties; with ties left, consecutive pages overlap and skip rows.
 */
export const PAGINATED_TRANSACTION_ORDER: Prisma.TransactionOrderByWithRelationInput[] = [
  { date: 'desc' },
  { createdAt: 'desc' },
  { id: 'desc' },
];
