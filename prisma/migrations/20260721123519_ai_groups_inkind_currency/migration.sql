-- CreateEnum
CREATE TYPE "GroupKind" AS ENUM ('FAMILY_SIDE', 'FAMILY', 'FRIENDS', 'WORKMATES', 'CHURCH', 'SCHOOL', 'VILLAGE', 'COMMITTEE', 'DIASPORA', 'CLAN', 'OTHER');

-- AlterTable
ALTER TABLE "fulfillment" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'UGX';

-- AlterTable
ALTER TABLE "pledge" ADD COLUMN     "description" TEXT,
ADD COLUMN     "estimated_value" BIGINT,
ADD COLUMN     "quantity" INTEGER,
ADD COLUMN     "unit" TEXT;

-- CreateTable
CREATE TABLE "contributor_group" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "GroupKind" NOT NULL DEFAULT 'OTHER',
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contributor_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_group" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "role" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_group_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contributor_group_event_id_idx" ON "contributor_group"("event_id");

-- CreateIndex
CREATE INDEX "person_group_event_id_idx" ON "person_group"("event_id");

-- CreateIndex
CREATE INDEX "person_group_group_id_idx" ON "person_group"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "person_group_person_id_group_id_key" ON "person_group"("person_id", "group_id");

-- AddForeignKey
ALTER TABLE "contributor_group" ADD CONSTRAINT "contributor_group_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contributor_group" ADD CONSTRAINT "contributor_group_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_group" ADD CONSTRAINT "person_group_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_group" ADD CONSTRAINT "person_group_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_group" ADD CONSTRAINT "person_group_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "contributor_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- RLS for the two new event-scoped tables (same tenant_isolation as the rest).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
  tenant_tables text[] := ARRAY['contributor_group', 'person_group'];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
      USING (event_id = app_current_event_id()) WITH CHECK (event_id = app_current_event_id())', t);
  END LOOP;
END $$;
