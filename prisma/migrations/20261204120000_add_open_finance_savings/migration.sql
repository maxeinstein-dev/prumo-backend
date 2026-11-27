-- P25 L2b1: savings (cofrinhos) of the linked bank accounts, to split the daily yield and ignore money outside Prumo.
-- Additive: one new table, nothing else changes.
-- CreateTable
CREATE TABLE "open_finance_savings" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "in_prumo" BOOLEAN NOT NULL DEFAULT true,
    "approx_balance" DECIMAL(15,2),
    "balance_as_of" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "open_finance_savings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "open_finance_savings_household_id_name_key" ON "open_finance_savings"("household_id", "name");

-- AddForeignKey
ALTER TABLE "open_finance_savings" ADD CONSTRAINT "open_finance_savings_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

