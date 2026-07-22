-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 1 — Row-Level Security by event_id + append-only immutability triggers.
--
-- Tenancy (blueprint §8, invariant §3.7): the tenant is the EVENT. Every
-- tenant-scoped table is filtered by `event_id = current_setting(
-- 'app.current_event_id')`. The app sets that GUC (transaction-local) at the
-- start of every tenant transaction; a query with the GUC unset matches NO
-- rows (fail closed). FORCE ROW LEVEL SECURITY makes the policy apply even to
-- the table owner (the role Neon connects as).
--
-- Append-only (invariant §3.1/§3.3/§3.4): audit_event can never be UPDATEd or
-- DELETEd. Corrections are new rows, so history is immutable.
-- ─────────────────────────────────────────────────────────────────────────────

-- Helper: read the current tenant from the GUC, NULL if unset (missing_ok=true).
CREATE OR REPLACE FUNCTION app_current_event_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.current_event_id', true), '')::uuid $$;

-- Apply an identical event_id policy to every tenant-scoped table.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'event_member', 'person', 'pledge', 'fulfillment',
    'budget', 'budget_item', 'allocation', 'audit_event', 'outbox'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    -- USING gates reads/updates/deletes; WITH CHECK gates inserts/updates so a
    -- row can never be written into another event's tenant.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (event_id = app_current_event_id())
         WITH CHECK (event_id = app_current_event_id())', t);
  END LOOP;
END $$;

-- audit_event is append-only: block UPDATE and DELETE at the database.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only; % is not permitted',
    TG_TABLE_NAME, TG_OP;
END $$;

DROP TRIGGER IF EXISTS audit_event_append_only ON audit_event;
CREATE TRIGGER audit_event_append_only
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
