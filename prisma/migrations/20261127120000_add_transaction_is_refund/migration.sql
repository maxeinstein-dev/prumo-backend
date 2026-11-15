-- Estorno: marcador explicito em transacoes (aditivo: uma coluna com default false, nenhuma linha existente muda de valor)
-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "is_refund" BOOLEAN NOT NULL DEFAULT false;
