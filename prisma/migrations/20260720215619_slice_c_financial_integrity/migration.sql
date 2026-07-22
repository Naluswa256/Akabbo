-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('MTN', 'AIRTEL', 'CASH', 'BANK', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('REPORTED', 'UNVERIFIED', 'VERIFIED');

-- AlterTable
ALTER TABLE "fulfillment" ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "method" "PaymentMethod" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "note" TEXT,
ADD COLUMN     "verification_status" "VerificationStatus" NOT NULL DEFAULT 'REPORTED';

-- AlterTable
ALTER TABLE "pledge" ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "is_direct" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "fulfillment_pledge_id_value_created_at_idx" ON "fulfillment"("pledge_id", "value", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "fulfillment_event_id_idempotency_key_key" ON "fulfillment"("event_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "pledge_event_id_idempotency_key_key" ON "pledge"("event_id", "idempotency_key");

