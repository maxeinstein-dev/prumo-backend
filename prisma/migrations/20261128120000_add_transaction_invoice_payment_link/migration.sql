-- Vinculo "este lancamento paga a fatura X" em colunas proprias (aditivo: duas colunas anulaveis, nenhuma linha muda
-- de valor nas colunas existentes). Ate aqui o vinculo vivia so no texto de attachment_url
-- (`invoice_pay:<conta do cartao>:<ano>-<mes base zero, sem zero a esquerda>`); o texto continua sendo gravado e lido.
-- invoice_payment_month guarda o mes da fatura como mes civil `AAAA-MM` (o texto usa mes base zero: 2026-9 = 2026-10).
-- Sem chave estrangeira de proposito: apagar a conta do cartao nao pode apagar nem soltar o pagamento.
-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "invoice_payment_account_id" UUID,
ADD COLUMN "invoice_payment_month" VARCHAR(7);

-- Backfill: so o texto que casa exatamente com o formato gravado pelo app (uuid minusculo, mes 0 a 11 sem zero a
-- esquerda). O que nao casar fica nulo e continua valendo pelo texto.
UPDATE "transactions" t
SET "invoice_payment_account_id" = m.parts[1]::uuid,
    "invoice_payment_month" = m.parts[2] || '-' || lpad((m.parts[3]::int + 1)::text, 2, '0')
FROM (
  SELECT "id", regexp_match(
    "attachment_url",
    '^invoice_pay:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9]{4})-([0-9]|1[01])$'
  ) AS parts
  FROM "transactions"
  WHERE "attachment_url" LIKE 'invoice_pay:%'
) m
WHERE t."id" = m."id" AND m.parts IS NOT NULL;

-- CreateIndex
CREATE INDEX "transactions_household_id_invoice_payment_account_id_idx" ON "transactions"("household_id", "invoice_payment_account_id");
