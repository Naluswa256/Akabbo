-- CreateEnum
CREATE TYPE "EventRole" AS ENUM ('OWNER', 'COORDINATOR', 'FINANCE', 'VIEWER');

-- CreateEnum
CREATE TYPE "PledgeType" AS ENUM ('CASH', 'ITEM', 'SERVICE');

-- CreateEnum
CREATE TYPE "PledgeStatus" AS ENUM ('PLEDGED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FulfillmentKind" AS ENUM ('PAYMENT', 'DELIVERY');

-- CreateEnum
CREATE TYPE "ProvenanceSource" AS ENUM ('human_typed', 'ai_from_chat', 'ai_from_document', 'ai_from_payment_sms', 'manual_correction', 'import');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "phone_verified" BOOLEAN NOT NULL DEFAULT false,
    "display_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_otp_challenge" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_otp_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UGX',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_member" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "EventRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "phone" TEXT,
    "source" "ProvenanceSource" NOT NULL DEFAULT 'human_typed',
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pledge" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "type" "PledgeType" NOT NULL DEFAULT 'CASH',
    "committed_value" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UGX',
    "status" "PledgeStatus" NOT NULL DEFAULT 'PLEDGED',
    "target_budget_item_id" UUID,
    "source" "ProvenanceSource" NOT NULL DEFAULT 'human_typed',
    "confidence" DOUBLE PRECISION,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillment" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "pledge_id" UUID NOT NULL,
    "kind" "FulfillmentKind" NOT NULL DEFAULT 'PAYMENT',
    "value" BIGINT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "ProvenanceSource" NOT NULL DEFAULT 'human_typed',
    "confidence" DOUBLE PRECISION,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fulfillment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Main budget',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_item" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "budget_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "target_value" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocation" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "fulfillment_id" UUID NOT NULL,
    "budget_item_id" UUID NOT NULL,
    "value" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "source" "ProvenanceSource" NOT NULL DEFAULT 'human_typed',
    "old_value" JSONB,
    "new_value" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "idempotency_key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_phone_key" ON "user"("phone");

-- CreateIndex
CREATE INDEX "auth_otp_challenge_phone_idx" ON "auth_otp_challenge"("phone");

-- CreateIndex
CREATE INDEX "event_owner_user_id_idx" ON "event"("owner_user_id");

-- CreateIndex
CREATE INDEX "event_member_user_id_idx" ON "event_member"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_member_event_id_user_id_key" ON "event_member"("event_id", "user_id");

-- CreateIndex
CREATE INDEX "person_event_id_idx" ON "person"("event_id");

-- CreateIndex
CREATE INDEX "pledge_event_id_idx" ON "pledge"("event_id");

-- CreateIndex
CREATE INDEX "pledge_person_id_idx" ON "pledge"("person_id");

-- CreateIndex
CREATE INDEX "fulfillment_event_id_idx" ON "fulfillment"("event_id");

-- CreateIndex
CREATE INDEX "fulfillment_pledge_id_idx" ON "fulfillment"("pledge_id");

-- CreateIndex
CREATE INDEX "budget_event_id_idx" ON "budget"("event_id");

-- CreateIndex
CREATE INDEX "budget_item_event_id_idx" ON "budget_item"("event_id");

-- CreateIndex
CREATE INDEX "budget_item_budget_id_idx" ON "budget_item"("budget_id");

-- CreateIndex
CREATE INDEX "allocation_event_id_idx" ON "allocation"("event_id");

-- CreateIndex
CREATE INDEX "audit_event_event_id_created_at_idx" ON "audit_event"("event_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_event_resource_type_resource_id_idx" ON "audit_event"("resource_type", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_idempotency_key_key" ON "outbox"("idempotency_key");

-- CreateIndex
CREATE INDEX "outbox_status_created_at_idx" ON "outbox"("status", "created_at");

-- CreateIndex
CREATE INDEX "outbox_event_id_idx" ON "outbox"("event_id");

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_member" ADD CONSTRAINT "event_member_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_member" ADD CONSTRAINT "event_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person" ADD CONSTRAINT "person_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person" ADD CONSTRAINT "person_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pledge" ADD CONSTRAINT "pledge_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pledge" ADD CONSTRAINT "pledge_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pledge" ADD CONSTRAINT "pledge_target_budget_item_id_fkey" FOREIGN KEY ("target_budget_item_id") REFERENCES "budget_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment" ADD CONSTRAINT "fulfillment_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment" ADD CONSTRAINT "fulfillment_pledge_id_fkey" FOREIGN KEY ("pledge_id") REFERENCES "pledge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget" ADD CONSTRAINT "budget_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_item" ADD CONSTRAINT "budget_item_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_item" ADD CONSTRAINT "budget_item_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation" ADD CONSTRAINT "allocation_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation" ADD CONSTRAINT "allocation_fulfillment_id_fkey" FOREIGN KEY ("fulfillment_id") REFERENCES "fulfillment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation" ADD CONSTRAINT "allocation_budget_item_id_fkey" FOREIGN KEY ("budget_item_id") REFERENCES "budget_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
