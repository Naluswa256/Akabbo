-- CreateEnum
CREATE TYPE "UsageKind" AS ENUM ('llm_call', 'sms', 'doc', 'storage');

-- CreateEnum
CREATE TYPE "ConfirmationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "usage_event" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "kind" "UsageKind" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "cost_micro_usd" BIGINT NOT NULL DEFAULT 0,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "model" TEXT,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_confirmation" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "intent" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION,
    "source" "ProvenanceSource" NOT NULL DEFAULT 'ai_from_chat',
    "status" "ConfirmationStatus" NOT NULL DEFAULT 'PENDING',
    "prompt" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "pending_confirmation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usage_event_event_id_created_at_idx" ON "usage_event"("event_id", "created_at");

-- CreateIndex
CREATE INDEX "usage_event_kind_created_at_idx" ON "usage_event"("kind", "created_at");

-- CreateIndex
CREATE INDEX "pending_confirmation_event_id_status_idx" ON "pending_confirmation"("event_id", "status");

-- AddForeignKey
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_confirmation" ADD CONSTRAINT "pending_confirmation_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
