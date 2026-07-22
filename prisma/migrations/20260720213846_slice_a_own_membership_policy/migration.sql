-- Slice A — cross-event read of YOUR OWN memberships ("My Events", §26).
--
-- RLS scopes every tenant table to ONE event via `app.current_event_id`. But
-- "My Events" is inherently cross-event: it spans every event a user belongs
-- to, so it can never satisfy a single-event GUC. Rather than weaken tenancy,
-- we add a second, narrower capability: a user may always READ their own
-- event_member rows, identified by `app.current_user_id`.
--
-- WRITES stay strictly tenant-scoped (WITH CHECK is unchanged) — this only
-- widens what you can SEE about yourself, never what you can change.

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid $$;

DROP POLICY IF EXISTS tenant_isolation ON event_member;
CREATE POLICY tenant_isolation ON event_member
  USING (event_id = app_current_event_id() OR user_id = app_current_user_id())
  WITH CHECK (event_id = app_current_event_id());
