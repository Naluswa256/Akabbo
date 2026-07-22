-- CreateEnum
CREATE TYPE "PlanScope" AS ENUM ('EVENT', 'ACCOUNT');

-- CreateEnum
CREATE TYPE "GrantStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SmsLedgerKind" AS ENUM ('GRANT', 'RESERVE', 'COMMIT', 'REFUND');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "billing_account" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "gateway_customer_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "PlanScope" NOT NULL,
    "price_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'UGX',
    "max_contributors" INTEGER,
    "included_sms_credits" INTEGER NOT NULL DEFAULT 0,
    "features" TEXT[],
    "is_subscription" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlement_grant" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "event_id" UUID,
    "account_id" UUID,
    "status" "GrantStatus" NOT NULL DEFAULT 'TRIALING',
    "period_start" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "period_end" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entitlement_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_credit_ledger" (
    "id" UUID NOT NULL,
    "event_id" UUID,
    "account_id" UUID,
    "kind" "SmsLedgerKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice" (
    "id" UUID NOT NULL,
    "billing_account_id" UUID NOT NULL,
    "plan_id" UUID,
    "event_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UGX',
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "reference" TEXT NOT NULL,
    "gateway_transaction_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_account_owner_user_id_idx" ON "billing_account"("owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_code_key" ON "plan"("code");

-- CreateIndex
CREATE INDEX "entitlement_grant_account_id_idx" ON "entitlement_grant"("account_id");

-- CreateIndex
CREATE INDEX "entitlement_grant_plan_id_idx" ON "entitlement_grant"("plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "entitlement_grant_event_id_key" ON "entitlement_grant"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_credit_ledger_idempotency_key_key" ON "sms_credit_ledger"("idempotency_key");

-- CreateIndex
CREATE INDEX "sms_credit_ledger_event_id_idx" ON "sms_credit_ledger"("event_id");

-- CreateIndex
CREATE INDEX "sms_credit_ledger_account_id_idx" ON "sms_credit_ledger"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_reference_key" ON "invoice"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_gateway_transaction_id_key" ON "invoice"("gateway_transaction_id");

-- CreateIndex
CREATE INDEX "invoice_billing_account_id_idx" ON "invoice"("billing_account_id");

-- AddForeignKey
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement_grant" ADD CONSTRAINT "entitlement_grant_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement_grant" ADD CONSTRAINT "entitlement_grant_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement_grant" ADD CONSTRAINT "entitlement_grant_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_billing_account_id_fkey" FOREIGN KEY ("billing_account_id") REFERENCES "billing_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- sms_credit_ledger is APPEND-ONLY (metering doc §6/§7.4) — block UPDATE/DELETE
-- at the database, exactly like audit_event. Balance is derived from SUM(amount);
-- corrections are new rows (e.g. a REFUND), never in-place edits.
-- ─────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS sms_credit_ledger_append_only ON sms_credit_ledger;
CREATE TRIGGER sms_credit_ledger_append_only
  BEFORE UPDATE OR DELETE ON sms_credit_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed the plan catalog (metering doc §4/§5). Idempotent on `code`.
-- Prices are UGX minor units (UGX has no minor unit → integer amount).
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO plan (id, code, name, scope, price_minor, currency, max_contributors, included_sms_credits, features, is_subscription)
VALUES
  (gen_random_uuid(), 'FREE',          'Free',           'EVENT',        0, 'UGX',   25,   30, ARRAY['ai_capture','dashboard','one_budget_doc','watermarked_summary'], false),
  (gen_random_uuid(), 'STARTER',       'Starter',        'EVENT',    50000, 'UGX',  100,  300, ARRAY['ai_capture','dashboard','unwatermarked_reports','reminders','seats_2'], false),
  (gen_random_uuid(), 'STANDARD',      'Standard',       'EVENT',   120000, 'UGX',  300, 1000, ARRAY['ai_capture','dashboard','unwatermarked_reports','reminders','priority_extraction','seats_5','budget_allocation'], false),
  (gen_random_uuid(), 'PREMIUM',       'Premium',        'EVENT',   250000, 'UGX', 1000, 3000, ARRAY['ai_capture','dashboard','unwatermarked_reports','reminders','priority_extraction','sender_id','advanced_reports','priority_support','unlimited_seats'], false),
  (gen_random_uuid(), 'ORGANIZER_PRO', 'Organizer Pro',  'ACCOUNT', 100000, 'UGX', NULL, 1000, ARRAY['ai_capture','dashboard','unwatermarked_reports','reminders','seats_5'], true),
  (gen_random_uuid(), 'BUSINESS',      'Business',       'ACCOUNT', 300000, 'UGX', NULL, 5000, ARRAY['ai_capture','dashboard','unwatermarked_reports','reminders','sender_id','advanced_reports','unlimited_seats','cross_event_analytics'], true)
ON CONFLICT (code) DO NOTHING;
