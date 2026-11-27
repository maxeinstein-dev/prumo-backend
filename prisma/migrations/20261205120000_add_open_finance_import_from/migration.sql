-- P25 L2b2: day the Open Finance import started for each linked account (drafts only from that day on).
-- Additive: one nullable column, nothing else changes.
ALTER TABLE "open_finance_links" ADD COLUMN "import_from" DATE;
