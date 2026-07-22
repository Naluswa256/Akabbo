-- Phase 2 — RLS on the new tenant-scoped tables, and append-only immutability
-- for the usage_event meter (metering doc §7.4: money/meter tables never mutate
-- in place). Same event_id policy shape as the Phase 1 tenant tables.

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY['usage_event', 'pending_confirmation'];
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

-- usage_event is append-only (reuses the trigger function from Phase 1).
DROP TRIGGER IF EXISTS usage_event_append_only ON usage_event;
CREATE TRIGGER usage_event_append_only
  BEFORE UPDATE OR DELETE ON usage_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
