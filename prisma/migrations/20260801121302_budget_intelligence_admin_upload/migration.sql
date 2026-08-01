-- AlterEnum
ALTER TYPE "BudgetKnowledgeSourceType" ADD VALUE 'admin_upload';

-- AlterTable
ALTER TABLE "budget_knowledge_source" ADD COLUMN     "mime_type" TEXT,
ADD COLUMN     "original_filename" TEXT,
ADD COLUMN     "storage_key" TEXT;
