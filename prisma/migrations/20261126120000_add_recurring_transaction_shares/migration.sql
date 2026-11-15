-- P19: default split of a recurrence (additive: a new table, nothing else changes)
-- CreateTable
CREATE TABLE "recurring_transaction_shares" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "recurring_transaction_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "percent" DECIMAL(5,2),
    "amount" DECIMAL(12,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_transaction_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recurring_transaction_shares_household_id_idx" ON "recurring_transaction_shares"("household_id");

-- CreateIndex
CREATE UNIQUE INDEX "recurring_transaction_shares_recurring_transaction_id_perso_key" ON "recurring_transaction_shares"("recurring_transaction_id", "person_id");

-- AddForeignKey
ALTER TABLE "recurring_transaction_shares" ADD CONSTRAINT "recurring_transaction_shares_recurring_transaction_id_fkey" FOREIGN KEY ("recurring_transaction_id") REFERENCES "recurring_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_transaction_shares" ADD CONSTRAINT "recurring_transaction_shares_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Exactly one of percent / amount, each positive, the percent at most 100
ALTER TABLE "recurring_transaction_shares" ADD CONSTRAINT "recurring_transaction_shares_kind_check" CHECK (
  (percent IS NOT NULL AND amount IS NULL AND percent > 0 AND percent <= 100)
  OR (percent IS NULL AND amount IS NOT NULL AND amount > 0)
);
