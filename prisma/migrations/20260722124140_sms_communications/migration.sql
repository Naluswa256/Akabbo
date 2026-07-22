-- CreateEnum
CREATE TYPE "SmsCampaignKind" AS ENUM ('REMINDER', 'ANNOUNCEMENT', 'THANK_YOU', 'CUSTOM');

-- CreateEnum
CREATE TYPE "SmsCampaignStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "SmsStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "sms_campaign" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "kind" "SmsCampaignKind" NOT NULL,
    "body" TEXT NOT NULL,
    "status" "SmsCampaignStatus" NOT NULL DEFAULT 'QUEUED',
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_message" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "campaign_id" UUID,
    "person_id" UUID,
    "to_phone" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "SmsStatus" NOT NULL DEFAULT 'QUEUED',
    "segments" INTEGER NOT NULL DEFAULT 1,
    "provider_message_id" TEXT,
    "reserve_key" TEXT NOT NULL,
    "error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sms_campaign_event_id_idx" ON "sms_campaign"("event_id");

-- CreateIndex
CREATE INDEX "sms_message_event_id_idx" ON "sms_message"("event_id");

-- CreateIndex
CREATE INDEX "sms_message_campaign_id_idx" ON "sms_message"("campaign_id");

-- CreateIndex
CREATE INDEX "sms_message_event_id_status_idx" ON "sms_message"("event_id", "status");

-- AddForeignKey
ALTER TABLE "sms_campaign" ADD CONSTRAINT "sms_campaign_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_message" ADD CONSTRAINT "sms_message_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_message" ADD CONSTRAINT "sms_message_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "sms_campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_message" ADD CONSTRAINT "sms_message_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- RLS for the two new event-scoped Communications tables (same tenant_isolation).
DO $$
DECLARE t text; tenant_tables text[] := ARRAY['sms_campaign', 'sms_message'];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
      USING (event_id = app_current_event_id()) WITH CHECK (event_id = app_current_event_id())', t);
  END LOOP;
END $$;
