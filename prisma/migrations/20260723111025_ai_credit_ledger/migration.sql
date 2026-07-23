-- CreateEnum
CREATE TYPE "AiLedgerKind" AS ENUM ('GRANT', 'DEDUCT', 'REFUND');

-- AlterTable: add included_ai_credits to plan
ALTER TABLE "plan" ADD COLUMN "included_ai_credits" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ai_credit_ledger" (
    "id" UUID NOT NULL,
    "event_id" UUID,
    "account_id" UUID,
    "kind" "AiLedgerKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_credit_ledger_idempotency_key_key" ON "ai_credit_ledger"("idempotency_key");

-- CreateIndex
CREATE INDEX "ai_credit_ledger_event_id_idx" ON "ai_credit_ledger"("event_id");

-- CreateIndex
CREATE INDEX "ai_credit_ledger_account_id_idx" ON "ai_credit_ledger"("account_id");
