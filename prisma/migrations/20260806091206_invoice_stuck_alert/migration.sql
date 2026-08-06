-- AlterTable
ALTER TABLE "invoice" ADD COLUMN     "stuck_alert_sent_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "invoice_status_created_at_idx" ON "invoice"("status", "created_at");

