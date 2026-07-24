-- CreateTable: ai_report_state for AI dynamic reporting and large dataset interaction
CREATE TABLE IF NOT EXISTS "ai_report_state" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "report_type" TEXT NOT NULL,
    "filters_json" TEXT NOT NULL,
    "sort_json" TEXT,
    "total_records" INTEGER NOT NULL,
    "total_amount" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_report_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ai_report_state_event_id_idx" ON "ai_report_state"("event_id");
CREATE INDEX IF NOT EXISTS "ai_report_state_user_id_idx" ON "ai_report_state"("user_id");
