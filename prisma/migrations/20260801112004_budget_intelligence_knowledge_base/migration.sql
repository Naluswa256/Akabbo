-- CreateEnum
CREATE TYPE "BudgetKnowledgeSourceType" AS ENUM ('manual_entry', 'public_article', 'user_upload', 'akabbo_aggregate');

-- CreateEnum
CREATE TYPE "BudgetKnowledgeReliability" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "BudgetKnowledgeExtractionMethod" AS ENUM ('manual', 'ai_extraction_reviewed', 'ai_extraction_live');

-- CreateEnum
CREATE TYPE "BudgetTier" AS ENUM ('budget', 'mid', 'premium');

-- AlterEnum
ALTER TYPE "ProvenanceSource" ADD VALUE 'ai_suggested';

-- AlterTable
ALTER TABLE "ai_learned_exemplar" ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateTable
CREATE TABLE "budget_knowledge_source" (
    "id" UUID NOT NULL,
    "source_type" "BudgetKnowledgeSourceType" NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "published_at" TIMESTAMP(3),
    "collected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reliability" "BudgetKnowledgeReliability" NOT NULL,
    "licensing_note" TEXT NOT NULL,
    "extraction_method" "BudgetKnowledgeExtractionMethod" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_knowledge_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_knowledge_observation" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "region" TEXT,
    "tier" "BudgetTier",
    "category" TEXT NOT NULL,
    "item" TEXT,
    "amount_min" BIGINT,
    "amount_max" BIGINT,
    "unit" TEXT,
    "commonly_forgotten" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_knowledge_observation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "budget_knowledge_observation_event_type_region_idx" ON "budget_knowledge_observation"("event_type", "region");

-- AddForeignKey
ALTER TABLE "budget_knowledge_observation" ADD CONSTRAINT "budget_knowledge_observation_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "budget_knowledge_source"("id") ON DELETE CASCADE ON UPDATE CASCADE;
