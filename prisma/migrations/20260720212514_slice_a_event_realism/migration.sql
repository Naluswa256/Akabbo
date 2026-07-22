-- Slice A — Event realism (§3, §12, §33): lifecycle status, target amount,
-- event date, and regional context (timezone/country) kept as DATA so regional
-- expansion is a value change, not an architecture change.

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'CLOSED', 'ARCHIVED');

-- AlterTable: additive columns with safe defaults.
ALTER TABLE "event" ADD COLUMN     "country" TEXT NOT NULL DEFAULT 'UG',
ADD COLUMN     "event_date" TIMESTAMP(3),
ADD COLUMN     "status" "EventStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "target_amount" BIGINT,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Africa/Kampala';

-- `slug` is NOT NULL + UNIQUE, so it is added nullable, backfilled for any
-- existing rows, and only then constrained. (A bare `ADD COLUMN slug TEXT NOT
-- NULL` fails on a non-empty table.)
ALTER TABLE "event" ADD COLUMN "slug" TEXT;
UPDATE "event" SET "slug" = 'event-' || substr(replace("id"::text, '-', ''), 1, 12) WHERE "slug" IS NULL;
ALTER TABLE "event" ALTER COLUMN "slug" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "event_slug_key" ON "event"("slug");
