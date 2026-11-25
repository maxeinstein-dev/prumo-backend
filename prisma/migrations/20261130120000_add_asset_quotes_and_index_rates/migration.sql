-- P21 L2: market data for the investments (additive: one enum and two new tables, nothing else changes).
-- Global tables (no household): the same close or index rate serves every household.
-- Units of index_rates.value, as the Banco Central publishes them in the SGS series:
--   CDI   series 12, percent PER DAY (0.055131 = 0.055131% a.d.), one row per business day
--   SELIC series 11, percent PER DAY, one row per business day
--   IPCA  series 433, percent PER MONTH (0.44 = 0.44% in the month), dated on the 1st day of the reference month

-- CreateEnum
CREATE TYPE "MarketIndex" AS ENUM ('CDI', 'SELIC', 'IPCA');

-- CreateTable
CREATE TABLE "asset_quotes" (
    "id" UUID NOT NULL,
    "ticker" VARCHAR(20) NOT NULL,
    "date" DATE NOT NULL,
    "close_price" DECIMAL(15,6) NOT NULL,
    "source" VARCHAR(20) NOT NULL DEFAULT 'brapi',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "index_rates" (
    "id" UUID NOT NULL,
    "index_name" "MarketIndex" NOT NULL,
    "date" DATE NOT NULL,
    "value" DECIMAL(14,8) NOT NULL,
    "source" VARCHAR(20) NOT NULL DEFAULT 'bcb',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "index_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "asset_quotes_ticker_date_key" ON "asset_quotes"("ticker", "date");

-- CreateIndex
CREATE INDEX "asset_quotes_ticker_date_idx" ON "asset_quotes"("ticker", "date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "index_rates_index_name_date_key" ON "index_rates"("index_name", "date");

-- A close is a positive price
ALTER TABLE "asset_quotes" ADD CONSTRAINT "asset_quotes_close_price_check" CHECK ("close_price" > 0);
