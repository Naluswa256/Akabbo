-- CreateEnum
CREATE TYPE "ContributorVisibility" AS ENUM ('NAMES_AND_AMOUNTS', 'NAMES_ONLY', 'AGGREGATE_ONLY', 'HIDDEN');

-- CreateEnum
CREATE TYPE "BudgetVisibility" AS ENUM ('PUBLIC', 'PARTIALLY_PUBLIC', 'HIDDEN');

-- CreateEnum
CREATE TYPE "AnnouncementStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "budget_item" ADD COLUMN     "is_public" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "event" ADD COLUMN     "budget_visibility" "BudgetVisibility" NOT NULL DEFAULT 'PUBLIC',
ADD COLUMN     "contributor_visibility" "ContributorVisibility" NOT NULL DEFAULT 'NAMES_AND_AMOUNTS',
ADD COLUMN     "description" TEXT,
ADD COLUMN     "is_public" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "public_access_token" TEXT,
ADD COLUMN     "public_revision" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "event_announcement" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "status" "AnnouncementStatus" NOT NULL DEFAULT 'DRAFT',
    "source" "ProvenanceSource" NOT NULL DEFAULT 'human_typed',
    "created_by" UUID,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_instruction" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'OTHER',
    "label" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_instruction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_announcement_event_id_idx" ON "event_announcement"("event_id");

-- CreateIndex
CREATE INDEX "event_announcement_event_id_status_idx" ON "event_announcement"("event_id", "status");

-- CreateIndex
CREATE INDEX "payment_instruction_event_id_idx" ON "payment_instruction"("event_id");

-- AddForeignKey
ALTER TABLE "event_announcement" ADD CONSTRAINT "event_announcement_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_announcement" ADD CONSTRAINT "event_announcement_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_instruction" ADD CONSTRAINT "payment_instruction_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_instruction" ADD CONSTRAINT "payment_instruction_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security for the two new event-scoped tables (transparency spec).
-- Same tenant_isolation policy as every other tenant table: rows are visible
-- only when app.current_event_id matches. The PUBLIC read path is NOT a bypass —
-- it resolves the slug, opens runInEvent(eventId) exactly like a member would,
-- and a deliberate projection selects only public fields. RLS still guarantees
-- cross-event isolation; nothing here weakens that.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY['event_announcement', 'payment_instruction'];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (event_id = app_current_event_id())
         WITH CHECK (event_id = app_current_event_id())', t);
  END LOOP;
END $$;
