-- CreateTable: ai_interaction_trace
CREATE TABLE IF NOT EXISTS "ai_interaction_trace" (
    "id" UUID NOT NULL,
    "conversation_id" UUID,
    "event_id" UUID,
    "user_id" UUID,
    "user_prompt" TEXT NOT NULL,
    "model_response" TEXT,
    "tool_calls_json" TEXT,
    "staged_status" TEXT,
    "user_role" TEXT,
    "latency_ms" INTEGER,
    "evaluated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_interaction_trace_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ai_reflection_log
CREATE TABLE IF NOT EXISTS "ai_reflection_log" (
    "id" UUID NOT NULL,
    "evaluated_turns_count" INTEGER NOT NULL,
    "insights_summary" TEXT NOT NULL,
    "identified_gaps" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_reflection_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ai_learned_exemplar
CREATE TABLE IF NOT EXISTS "ai_learned_exemplar" (
    "id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "trigger_keywords" TEXT[],
    "user_prompt_pattern" TEXT NOT NULL,
    "learned_guidance" TEXT NOT NULL,
    "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "occurrence_count" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_learned_exemplar_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes
CREATE INDEX IF NOT EXISTS "ai_interaction_trace_event_id_idx" ON "ai_interaction_trace"("event_id");
CREATE INDEX IF NOT EXISTS "ai_interaction_trace_user_id_idx" ON "ai_interaction_trace"("user_id");
CREATE INDEX IF NOT EXISTS "ai_interaction_trace_conversation_id_idx" ON "ai_interaction_trace"("conversation_id");
CREATE INDEX IF NOT EXISTS "ai_interaction_trace_evaluated_idx" ON "ai_interaction_trace"("evaluated");

CREATE INDEX IF NOT EXISTS "ai_learned_exemplar_category_idx" ON "ai_learned_exemplar"("category");
CREATE INDEX IF NOT EXISTS "ai_learned_exemplar_status_idx" ON "ai_learned_exemplar"("status");
