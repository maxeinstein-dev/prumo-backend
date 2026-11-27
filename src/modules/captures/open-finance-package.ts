/**
 * Package of the drafts made by the Open Finance import (P25 L2b2). There is no reader for it: the import writes the
 * reading itself (`parsed`), with the Prumo account of the bank account it came from (`accountId`) and, for the two
 * sides of a move between own accounts, the same `pairKey`.
 */
export const OPEN_FINANCE_PACKAGE = 'open-finance';
