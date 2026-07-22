-- Phase 4e — the trusted WORKER path for draining the transactional outbox.
--
-- Draining the outbox is inherently CROSS-EVENT (one worker, all events), so it
-- cannot satisfy the single-event tenant GUC — the same shape as "My Events".
-- Rather than weaken tenant isolation for user requests, we add a narrow escape
-- the outbox policy honours ONLY when `app.worker_mode` is on. User-facing code
-- never sets that GUC; the worker's drain loop does. WRITES by the worker are
-- still gated the same way (it only ever touches outbox rows it claimed).
--
-- This is trusted server infrastructure, not a user-reachable widening.

CREATE OR REPLACE FUNCTION app_is_worker() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT current_setting('app.worker_mode', true) = 'on' $$;

DROP POLICY IF EXISTS tenant_isolation ON outbox;
CREATE POLICY tenant_isolation ON outbox
  USING (event_id = app_current_event_id() OR app_is_worker())
  WITH CHECK (event_id = app_current_event_id() OR app_is_worker());
