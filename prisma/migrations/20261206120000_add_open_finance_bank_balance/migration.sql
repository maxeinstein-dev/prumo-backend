-- P25 L3: the bank's balance at the last Open Finance import, to compare with Prumo's balance.
-- Additive: three columns (nullable, or with a default), nothing else changes.
-- AlterTable
ALTER TABLE "open_finance_links" ADD COLUMN     "bank_balance" DECIMAL(15,2),
ADD COLUMN     "bank_balance_at" TIMESTAMPTZ(3),
ADD COLUMN     "bank_balance_estimated" BOOLEAN NOT NULL DEFAULT false;
