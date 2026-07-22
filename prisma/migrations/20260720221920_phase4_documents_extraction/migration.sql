-- CreateEnum
CREATE TYPE "FileKind" AS ENUM ('PROFILE_PHOTO', 'DOCUMENT', 'DOCUMENT_PHOTO', 'PAYMENT_EVIDENCE', 'CONTRIBUTION_EVIDENCE', 'EVENT_PHOTO');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'PROCESSED', 'FAILED', 'REQUIRES_REVIEW', 'APPROVED');

-- CreateEnum
CREATE TYPE "ExtractionKind" AS ENUM ('BUDGET', 'CONTRIBUTION_LIST', 'UNKNOWN');

-- AlterTable
ALTER TABLE "budget_item" ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "created_by" UUID,
ADD COLUMN     "source" "ProvenanceSource" NOT NULL DEFAULT 'human_typed',
ADD COLUMN     "source_document_id" UUID,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "file_object" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "kind" "FileKind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "original_filename" TEXT,
    "person_id" UUID,
    "uploaded_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_object_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "kind" "ExtractionKind" NOT NULL DEFAULT 'UNKNOWN',
    "status" "DocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "uploaded_by" UUID,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extraction" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "kind" "ExtractionKind" NOT NULL DEFAULT 'UNKNOWN',
    "structured" JSONB NOT NULL,
    "raw_text" TEXT,
    "confidence" DOUBLE PRECISION,
    "model" TEXT,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "file_object_event_id_idx" ON "file_object"("event_id");

-- CreateIndex
CREATE INDEX "file_object_event_id_kind_idx" ON "file_object"("event_id", "kind");

-- CreateIndex
CREATE INDEX "file_object_person_id_idx" ON "file_object"("person_id");

-- CreateIndex
CREATE INDEX "document_event_id_idx" ON "document"("event_id");

-- CreateIndex
CREATE INDEX "document_status_idx" ON "document"("status");

-- CreateIndex
CREATE INDEX "extraction_event_id_idx" ON "extraction"("event_id");

-- CreateIndex
CREATE INDEX "extraction_document_id_idx" ON "extraction"("document_id");

-- AddForeignKey
ALTER TABLE "budget_item" ADD CONSTRAINT "budget_item_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_object" ADD CONSTRAINT "file_object_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_object" ADD CONSTRAINT "file_object_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction" ADD CONSTRAINT "extraction_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction" ADD CONSTRAINT "extraction_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- RLS for the new tenant-scoped tables (invariant §3.7). Same event_id policy
-- shape as every other tenant table: a query without the tenant GUC matches no
-- rows (fail closed), so a document/photo can never leak across events.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY['file_object', 'document', 'extraction'];
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

-- An extraction is an immutable reading of a document at a point in time.
DROP TRIGGER IF EXISTS extraction_append_only ON extraction;
CREATE TRIGGER extraction_append_only
  BEFORE UPDATE OR DELETE ON extraction
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
