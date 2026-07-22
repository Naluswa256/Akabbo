# Akabbo

A permissioned, append-only ledger of event contributions, with a natural-language
capture layer and an SMS notification layer. **The ledger is the truth; the AI is a
replaceable interface on top of it.**

> This repository is at **Phase 2 — AI capture** (Phases 0 & 1 complete). On top of
> the typed ledger, natural language now flows through a tiered orchestrator:
> a deterministic parser handles well-shaped utterances at $0, the LLM handles the
> rest, entity resolution asks rather than guesses, low-confidence writes park in
> `pending_confirmation`, and every LLM call is metered. The AI calls the SAME
> domain services as the typed path — both gates enforced inside — so it has no
> privileged path and cannot bypass a permission check. Still **no SMS, no billing**
> (Phases 3 and 5). See the build plan in `CLAUDE.md`.

## Architecture (Phase 0)

One codebase → two processes, five bounded contexts to come.

```
apps/
  api/        NestJS HTTP service — /health, /health/ready
  worker/     Nest application context — heartbeat (later: outbox drain, reminders)
libs/
  config/         zod-validated env (fail-closed) + typed AppConfigService
  logging/        structured JSON logs (nestjs-pino) with PII redaction
  observability/  Sentry init (no-op when DSN blank)
  prisma/         PrismaService + module (empty domain schema in Phase 0)
  providers/      the five interfaces WE OWN + stub impls:
                  LlmProvider · SmsProvider · PaymentProvider · Storage · Auth
prisma/           schema.prisma (+ migrations)
docker/           entrypoint dispatches api|worker by APP_ROLE
cloudrun/         Cloud Run service definitions (api, worker)
```

Phase 1 adds three bounded-context libs:

```
libs/access/     the two deterministic gates: PermissionService (can()) +
                 EntitlementService (within_entitlement — stubbed-allow until Phase 5)
libs/identity/   users + phone-OTP/JWT auth (real AuthProvider impl)
libs/ledger/     the core: TenantContext (RLS + atomic txn), audit/outbox writers,
                 Event/Membership/Person/Pledge/Fulfillment services, outstanding math
```

**Locked foundation:** Cloudflare edge · Google Cloud Run · Neon Postgres · Cloudflare R2.
Every external dependency sits behind an interface we own (`libs/providers`) — no
vendor SDK ever reaches domain code.

### RLS requires a non-superuser DB role

Tenant isolation is enforced by Postgres Row-Level Security keyed on a
transaction-local `app.current_event_id` GUC. **A Postgres superuser bypasses RLS**,
so the app must connect as a non-superuser role:

- **Neon:** the default role is already non-superuser and owns the tables; the
  migration's `FORCE ROW LEVEL SECURITY` makes policies apply to it. One role is fine.
- **Local / CI (Docker Postgres, whose default role is a superuser):** run migrations
  as the owner, then connect the app/tests as the least-privilege role from
  `scripts/setup-app-role.sql` (`akabbo_app`). CI does this automatically.

## Prerequisites

- Node ≥ 22, pnpm 10 (`corepack enable`)
- Docker (for container builds)
- A Postgres to point at — a Neon branch (see `CREDENTIALS.md`) or local Postgres

## Local setup

```bash
corepack enable
pnpm install
cp .env.example .env          # then fill DATABASE_URL (+ DIRECT_URL)
pnpm prisma:generate          # generate the Prisma client
pnpm prisma:migrate:dev       # apply the Phase 0 migration to your DB
```

## Run

```bash
pnpm start:api:dev            # API on http://localhost:8080
pnpm start:worker:dev         # worker heartbeat every WORKER_HEARTBEAT_MS

curl localhost:8080/health          # liveness  → { "status": "ok" }
curl localhost:8080/health/ready    # readiness → proves DB reachability
```

## Quality gates (what CI runs)

```bash
pnpm lint          # eslint, zero warnings
pnpm format:check  # prettier
pnpm typecheck     # tsc --noEmit
pnpm test          # jest (unit + integration)
pnpm build         # nest build api && nest build worker
```

## Phase 0 — Definition of Done

- [x] `api` + `worker` boot from one codebase, two processes
- [x] Env validated fail-closed at boot
- [x] `/health` liveness + `/health/ready` (DB-backed) readiness
- [x] Worker beats a heartbeat and pings the DB
- [x] Structured JSON logging with PII redaction; Sentry wired (no-op without DSN)
- [x] Five provider interfaces we own, with fail-loud stubs
- [x] Prisma migration runs cleanly forward (empty domain schema)
- [x] CI: lint · format · typecheck · test · migrate · build
- [ ] Deploys to Cloud Run staging; health check passes ← needs your credentials

To finish the last box, follow **`CREDENTIALS.md`** (Neon + GCP + GitHub), then push.

## Deferred (do NOT build without a new decision)

Inbound SMS/MoMo ingestion · WhatsApp · pgvector · microservice extraction · Kafka
· Kubernetes · multi-currency · on-continent region · self-built OCR/auth/payments.
