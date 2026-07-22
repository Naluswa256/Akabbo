-- ─────────────────────────────────────────────────────────────────────────────
-- Create the least-privilege application role used at RUNTIME.
--
-- Why this exists: RLS is bypassed by SUPERUSER and BYPASSRLS roles. Migrations
-- are run by the owner/superuser, but the APP must connect as a NON-superuser
-- role so the event_id policies actually apply (invariant §3.7). This mirrors
-- production (Neon's app role is not a superuser).
--
-- Idempotent: safe to run after every migration. Run as the DB owner:
--   psql "$OWNER_URL" -v app_password=... -f scripts/setup-app-role.sql
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'akabbo_app') THEN
    CREATE ROLE akabbo_app LOGIN PASSWORD 'akabbo_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO akabbo_app;
-- TRUNCATE supports test-suite cleanup only; the app never truncates. RLS is a
-- DML row-visibility control and is unaffected by holding TRUNCATE.
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO akabbo_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO akabbo_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO akabbo_app;

-- Cover objects created by FUTURE migrations too.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO akabbo_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO akabbo_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO akabbo_app;
