-- P21 L1: investment positions and movements (additive: three enums and two new tables, nothing else changes)
-- CreateEnum
CREATE TYPE "InvestmentKind" AS ENUM ('STOCK_EXCHANGE', 'FIXED_INCOME');

-- CreateEnum
CREATE TYPE "InvestmentIndexer" AS ENUM ('CDI', 'IPCA', 'SELIC', 'PREFIXED');

-- CreateEnum
CREATE TYPE "InvestmentMovementType" AS ENUM ('OPENING', 'BUY', 'SELL', 'INCOME');

-- CreateTable
CREATE TABLE "investment_positions" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "kind" "InvestmentKind" NOT NULL,
    "ticker" VARCHAR(20),
    "name" VARCHAR(120) NOT NULL,
    "savings_goal_id" UUID,
    "indexer" "InvestmentIndexer",
    "rate" DECIMAL(9,4),
    "maturity_date" DATE,
    "anchor_amount" DECIMAL(15,2),
    "anchor_date" DATE,
    "closed_at" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "investment_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investment_movements" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "position_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "type" "InvestmentMovementType" NOT NULL,
    "quantity" DECIMAL(18,6),
    "unit_price" DECIMAL(15,6),
    "amount" DECIMAL(15,2) NOT NULL,
    "notes" VARCHAR(255),
    "source_ref" VARCHAR(120),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "investment_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "investment_positions_household_id_idx" ON "investment_positions"("household_id");

-- CreateIndex
CREATE INDEX "investment_positions_account_id_idx" ON "investment_positions"("account_id");

-- CreateIndex
CREATE INDEX "investment_positions_savings_goal_id_idx" ON "investment_positions"("savings_goal_id");

-- CreateIndex
CREATE INDEX "investment_movements_position_id_date_idx" ON "investment_movements"("position_id", "date");

-- CreateIndex
CREATE INDEX "investment_movements_household_id_idx" ON "investment_movements"("household_id");

-- CreateIndex
CREATE UNIQUE INDEX "investment_movements_household_id_source_ref_key" ON "investment_movements"("household_id", "source_ref");

-- AddForeignKey
ALTER TABLE "investment_positions" ADD CONSTRAINT "investment_positions_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investment_positions" ADD CONSTRAINT "investment_positions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investment_positions" ADD CONSTRAINT "investment_positions_savings_goal_id_fkey" FOREIGN KEY ("savings_goal_id") REFERENCES "savings_goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investment_movements" ADD CONSTRAINT "investment_movements_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investment_movements" ADD CONSTRAINT "investment_movements_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "investment_positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A movement never carries a negative value; a quantity, when present, is positive
ALTER TABLE "investment_movements" ADD CONSTRAINT "investment_movements_amount_check" CHECK ("amount" > 0);
ALTER TABLE "investment_movements" ADD CONSTRAINT "investment_movements_quantity_check" CHECK ("quantity" IS NULL OR "quantity" > 0);
