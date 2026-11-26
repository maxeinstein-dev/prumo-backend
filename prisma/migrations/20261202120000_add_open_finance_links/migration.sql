-- P25 L1: links of Open Finance (Meu Pluggy) items/accounts to the household and its accounts.
-- Additive: one new table, nothing else changes. No secret is stored here.
-- CreateTable
CREATE TABLE "open_finance_links" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "pluggy_item_id" VARCHAR(64) NOT NULL,
    "pluggy_account_id" VARCHAR(64),
    "account_id" UUID,
    "last_sync_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "open_finance_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "open_finance_links_household_id_pluggy_item_id_idx" ON "open_finance_links"("household_id", "pluggy_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "open_finance_links_household_id_pluggy_account_id_key" ON "open_finance_links"("household_id", "pluggy_account_id");

-- AddForeignKey
ALTER TABLE "open_finance_links" ADD CONSTRAINT "open_finance_links_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "open_finance_links" ADD CONSTRAINT "open_finance_links_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

