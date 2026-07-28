-- AlterTable
ALTER TABLE "event" ADD COLUMN "show_target" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "event" ADD COLUMN "show_outstanding" BOOLEAN NOT NULL DEFAULT true;
