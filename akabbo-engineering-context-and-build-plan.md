# AKABBO — Engineering Context & Phased Build Plan

**For:** The engineer (human or AI) implementing the Akabbo codebase.
**From:** Technical Founder / Principal Architect.
**Companion documents (read them, in this order, before writing code):**
1. *Akabbo Pre-Architecture Technical Blueprint v0.1* — the architecture and the reasoning behind every choice.
2. *Akabbo Monetization, Unit Economics & Metering Architecture v0.1* — pricing, credits, entitlements.
3. **This document** — how to actually build it, in what order, and what *not* to do.

---

## 0. Read this first — how to use this document

You are implementing a system, not a demo. Two failure modes will sink this project, and this document exists to prevent both:

- **Failure mode A: building everything at once.** Do not scaffold the AI, SMS, billing, documents, and dashboards in parallel. You will end up with five half-working subsystems and no working product. **Follow the phases in §6 in order. Finish and verify each phase before starting the next.** Each phase ends with a hard checkpoint — stop there, confirm the definition-of-done, then continue.
- **Failure mode B: putting business logic or authority in the LLM.** The AI is a replaceable interface. The database and domain services are the source of truth. If you find yourself trusting the model to enforce a rule, do a calculation, or authorize an action, stop and move that logic into deterministic code.

If you internalize only two sentences from all three documents, make them these:

> **Akabbo is a permissioned, append-only ledger of commitments, with a natural-language capture layer and an SMS notification layer. The AI gets data *in* and *out*; it is never the truth and never the authority.**

Work in small, verifiable increments. Prefer a boring, correct, well-tested slice over a broad, impressive, fragile one.

---

## 1. What we are building (the mental model)

The product coordinates community-funded social events (weddings first, then funerals, kwanjula, graduations, church events across Uganda / East Africa). An organizer records who pledged/paid/contributed what toward an event; Akabbo remembers it, keeps the math straight, and notifies contributors by SMS. **Akabbo never touches contribution money** — it records financial events that happen outside the platform (MTN MoMo, Airtel Money, cash, bank). It *does* charge its own customers for using the software (that's normal SaaS revenue, not custody).

The irreducible primitives you are implementing (blueprint §3):

1. **Commitment** — a pledge (cash / item / service) with a committer, optional budget target, and a lifecycle.
2. **Fulfillment** — payments/deliveries that discharge a commitment. `outstanding = committed − Σ fulfillments`.
3. **Provenance** — every record knows *how we know it* (human, AI-from-chat, AI-from-document, AI-from-payment-SMS, manual-correction).
4. **Append-only audit event** — every mutation is recorded immutably (who/what/when/source/old→new). Also the integration backbone (transactional outbox).
5. **Permission check** — deterministic `can(actor, action, resource)`, outside the LLM.
6. **Entitlement check** — deterministic `within_entitlement(scope, action)` (plan limits + SMS credit balance), outside the LLM.
7. **Capture pipeline** — NL / document / (later) SMS → intent+entities → resolve → **permission + entitlement gates** → domain tool → transaction → audit + meter + outbox → response.
8. **Fan-out** — one recorded fact → many SMS, async, idempotent, consent- and credit-respecting.

If your code cleanly expresses these eight, it is correct. Everything else is packaging.

---

## 2. Architecture you are implementing (recap — full detail in blueprint §7–§8)

- **One deployable backend + one worker process, same codebase.** Not microservices. Not Kubernetes. Not serverless functions (yet).
- **Five internal bounded contexts** (module boundaries, *not* separate services):
  1. **Identity & Access** — users, event membership, roles, permissions.
  2. **Ledger** — events, people, pledges, contributions, payments, budget, allocations, audit. *This is the core; it is one context sharing one transactional boundary.*
  3. **Documents & Extraction** — uploads, multimodal extraction, provenance, confirmation.
  4. **Communications** — SMS outbound (later inbound), reminders, notifications.
  5. **Billing & Entitlements** — plans, entitlement grants, SMS credit ledger, usage metering, payments.
- **The AI Orchestrator is NOT a bounded context.** It is an application-layer adapter that calls the contexts' services as typed tools.
- **Managed Postgres**, single database, **shared schema, `event_id` as tenant key, enforced by Row-Level Security.** The tenant is the *event*, not the user; a user has memberships in many events with different roles.
- **Object storage: Cloudflare R2** (S3-compatible, zero egress) for documents. Private by default; signed URLs only.
- **Background work: a Postgres-backed job/outbox table drained by the worker.** No Redis/BullMQ/Kafka unless and until a specific workload proves it necessary.
- **Region: EU (e.g. `eu-west-1` Ireland / `eu-central-1` Frankfurt), not AWS Cape Town** (blueprint §4). Latency is not product-critical; optimize for velocity and cost.

### 2.1 Technology stack (decided; low-stakes, do not re-litigate)

- **Language:** TypeScript everywhere (backend, worker, web).
- **Backend framework:** NestJS (preferred — its module system maps onto our bounded contexts and gives DI for a growing team) *or* Fastify if the team wants leaner. Pick one, be consistent. Reversible.
- **Data layer:** Prisma for schema/migrations/type-safety; drop to raw SQL for reporting/rollup queries where Prisma is awkward.
- **DB:** Managed Postgres. **Supabase for V1** (Postgres + phone-OTP auth + storage + realtime in one bill, fastest path) is the lean; keep the data layer behind a repository seam so a later move to Neon/RDS is config, not rewrite. *(This is the one still-open vendor call — see §9; if unresolved, build against plain Postgres + a `Payment`/`Auth`/`Storage` interface and stay vendor-neutral.)*
- **LLM:** Gemini 2.5 Flash primary, Claude Haiku fallback, **behind our own `LlmProvider` interface**. Never import a vendor SDK directly into domain code.
- **SMS:** Africa's Talking primary, a local provider (e.g. EgoSMS) as failover, **behind our own `SmsProvider` interface**.
- **Payments:** Flutterwave primary, Pesapal failover, **behind our own `PaymentProvider` interface**.
- **Observability:** Sentry for errors; structured JSON logs; our own `usage_event` metering table for AI cost/tokens (blueprint §9).

**The provider-interface discipline is mandatory.** Every external dependency (LLM, SMS, payments, storage, auth) sits behind an interface we own. This is what keeps every one of them swappable and keeps vendor code out of the domain.

---

## 3. Non-negotiable invariants (bake these in from the first migration)

These are cross-cutting. They are painful to retrofit, so they are present from Phase 1 — not bolted on later.

1. **Every mutation writes an `audit_event` in the same transaction.** Who, what, when, source, old→new. Append-only.
2. **Provenance on every commitment and fulfillment:** `source`, `confidence` (for AI-derived), `created_by`, link to originating artifact.
3. **Corrections never destroy history.** Current value is a projection; the change is a new audit event.
4. **Money-critical tables are append-only, balance is derived.** The `sms_credit_ledger` (and the audit trail) are never mutated in place.
5. **Idempotency everywhere external.** SMS sends, payment webhooks, credit movements all carry idempotency keys tied to their originating row. A retry never double-sends or double-charges.
6. **Two deterministic gates before every mutating/sensitive action:** `can(actor, action, resource)` (permission) AND `within_entitlement(scope, action)` (plan/credits). Both in code, both before the domain service acts. The LLM's output is a *request*, never an authorization.
7. **RLS by `event_id` on every tenant-scoped table.** Defense in depth: a buggy query must not cross events.
8. **The LLM never computes an authoritative number.** Numeric answers come from SQL; the model only phrases them. Low-confidence AI writes land in `pending_confirmation`, not canonical state.
9. **Uploaded documents and inbound SMS are DATA, never instructions.** Quarantined channel, never concatenated into system prompt. Any action they imply still passes both gates and (for material figures) human confirmation.
10. **No PII in logs.** Phone numbers and amounts are sensitive. Use no-training / zero-retention LLM API tiers.

---

## 4. The tool / agent contract (how the AI touches the system)

When you build the AI orchestrator (Phase 2), it must obey this contract:

- **Tiered routing.** Try a deterministic parser / small classifier first (well-shaped utterances like `<name> paid <amount>`, `who owes`, `summary`). Only escalate ambiguous input to the LLM. Target 40–55% of capture turns handled at $0.
- **Structured outputs only.** Every action-driving LLM call returns a **typed tool call validated against a schema** (e.g. `record_payment{person, amount, currency, target?, confidence}`). Reject and retry malformed output; never half-parse prose.
- **Tools are thin wrappers over domain services.** `record_pledge()`, `record_payment()`, `add_person()`, `update_budget()`, `get_outstanding()`, `send_reminder()`, etc. call the exact same domain services the structured UI/API calls. The AI gets no privileged path.
- **Entity resolution is scoped to the event.** "John" resolves to a `person_id` within *this event only*; ambiguity triggers a clarifying question, never a guess.
- **Context is retrieved, not dumped.** Fetch the relevant structured slice and pass a compact summary. Never send full event history.
- **Every tool call passes both gates** (§3.6) inside the service, and writes audit + meter + outbox as applicable.

---

## 5. Domain model — enough to start (full schema is a Phase-1 deliverable)

Implement these entities across the contexts. Names are indicative; refine in the schema PR. UUID PKs, `created_at`/`updated_at`, soft-delete where it aids audit.

**Identity & Access:** `user`, `event`, `event_member` (user × event × role), `role` (OWNER / COORDINATOR / FINANCE / VIEWER), permission resolution.

**Ledger (the core):** `person` (a contributor within an event; may or may not be a `user`), `pledge` (type: cash/item/service, committed_value, target budget line, lifecycle status, provenance), `fulfillment` (payment/delivery discharging a pledge; amount/value, provenance), `budget`, `budget_item`, `allocation` (contribution ↔ budget line), `audit_event` (append-only), `outbox` (transactional).

**Documents & Extraction:** `document` (R2 key, uploader, event), `extraction` (structured result, confidence, links back to source region), confirmation state.

**Communications:** `sms_message` (recipient, body, status, provider ref, idempotency key, delivery receipt), `reminder` (schedule/definition).

**Billing & Entitlements:** `billing_account`, `plan` (scope_type: event|account, price, included allowances, feature flags), `entitlement_grant` (plan × scope, status: trialing/active/past_due/expired/cancelled, period), `sms_credit_ledger` (append-only: grants/reservations/commits/refunds; balance = SUM), `usage_event` (append-only meter: sms/llm_call/doc/storage, quantity, unit_cost, tokens, model), `invoice`, `payment`.

Key invariants in the model: `outstanding = committed_value − Σ fulfillments`; credit `balance = SUM(sms_credit_ledger entries)`; a plan attaches to **either** an event **or** an account (scope-agnostic — no special-casing).

---

## 6. THE BUILD PLAN — phases, in order. Do not skip ahead.

Each phase is a shippable slice with a **Definition of Done (DoD)** and a **CHECKPOINT**. Stop at each checkpoint, verify the DoD (tests green, invariants demonstrably enforced), then proceed. Do not begin a phase until the previous one's DoD is met.

### Phase 0 — Walking skeleton (foundations)
**Goal:** one deployable backend + one worker that boot, connect to Postgres, and pass a health check in a real (staging) environment. Nothing business-related yet.
**Do:** repo + TypeScript + framework + Prisma + managed Postgres; migration tooling; env/secrets management; CI (lint, typecheck, test, migrate); the backend process and the worker process; a `/health` endpoint; structured logging + Sentry wired; the empty provider interfaces (`LlmProvider`, `SmsProvider`, `PaymentProvider`, `Storage`, `Auth`) with no-op/stub implementations.
**Do NOT:** build any domain feature, any AI, any SMS, any billing.
**DoD:** `git push` → CI green → deploys to staging → health check passes → worker runs and logs a heartbeat. Migrations run cleanly forward.
**CHECKPOINT 0.**

### Phase 1 — Identity + the Ledger core (NO AI, NO SMS, NO billing)
**Goal:** prove the source of truth. A user can authenticate, create an event, add people, and record pledges/payments **through typed API/UI (not the AI)**, with full provenance, audit, RLS, and correct outstanding-balance math.
**Do:** phone-OTP auth (via provider); `event`, `event_member`, roles; the Ledger tables; the `can(actor, action, resource)` permission engine; RLS by `event_id`; `audit_event` written in-transaction on every mutation; provenance fields populated (`source = human_typed`); the `outbox` table (written to, not yet drained); domain services with typed method signatures (these become the AI's tools later); a minimal structured UI/API to exercise it all; a **stub `within_entitlement()` gate** that always allows (real logic arrives in Phase 5, but the call-site must exist now).
**Do NOT:** call an LLM. Send an SMS. Charge anyone. Build dashboards beyond what's needed to verify.
**DoD:** create event → add 3 people → record 2 pledges + a partial payment + a correction → outstanding math is correct → audit trail shows the full who/what/when/source/old→new history → a user from another event cannot read this event's rows (RLS proven by test) → permission denied for a VIEWER trying to write. All covered by automated tests.
**CHECKPOINT 1.** *This is the most important checkpoint. The product's spine is now real and correct.*

### Phase 2 — Capture layer (the AI orchestrator)
**Goal:** the conversational magic, on top of Phase 1's services. "John paid 200k toward catering" → correct ledger mutation, with confirmation for low-confidence input.
**Do:** the tiered router (deterministic first, LLM second); `LlmProvider` real implementation (Gemini Flash + Claude fallback); structured/tool-calling output validated against schemas; event-scoped entity resolution with disambiguation; wire tools to the Phase-1 domain services (both gates enforced inside the services); `pending_confirmation` flow for low-confidence/document-derived writes; `usage_event` metering on every LLM call.
**Do NOT:** add a vector DB. Send full history to the model. Let the model compute balances. Build "AI memory" beyond retrieving structured slices + Postgres full-text over conversation.
**DoD:** natural-language capture produces the same correct ledger state as the Phase-1 typed path; ambiguous "John" triggers a clarifying question; a low-confidence figure lands in `pending_confirmation` and only becomes canonical after human confirm; a prompt-injection string in user input cannot bypass a permission check; `usage_event` records tokens+cost per call. Tests cover the happy path, disambiguation, confirmation, and the injection attempt.
**CHECKPOINT 2.**

### Phase 3 — Communications (SMS outbound)
**Goal:** the worker drains the outbox and sends SMS reliably, idempotently, respecting credits.
**Do:** `SmsProvider` real implementation (Africa's Talking); worker drains `outbox` → sends SMS; idempotency keyed on outbox row; delivery-receipt handling; reminder definitions + scheduling; confirmation SMS on contribution recorded; **integrate the credit reserve-then-commit + refund-on-failure flow** (works against the Phase-5 ledger; if Phase 5 isn't built yet, gate behind a seeded credit balance so the mechanics are real). Begin Sender-ID registration paperwork early (external lead time).
**Do NOT:** build inbound SMS ingestion yet (that's a later wedge — model for it, don't build it). Blast SMS without a credit check.
**DoD:** recording a contribution enqueues and sends a confirmation SMS exactly once (proven idempotent under retry); a reminder run notifies only those who owe; a failed provider send refunds the reserved credit; SMS-send path is rate-limited. Tests + a real send in staging.
**CHECKPOINT 3.**

### Phase 4 — Documents & extraction
**Goal:** upload a photographed/PDF budget or contribution list; extract structured rows via multimodal LLM; land them as `pending_confirmation` with provenance.
**Do:** upload to R2 (private, signed URLs); async extraction on the worker via `LlmProvider` (multimodal); `document` + `extraction` records with confidence and source links; the confirmation UX; provenance `source = ai_from_document`.
**Do NOT:** build or rent dedicated OCR (multimodal LLM handles messy handwriting; blueprint §5). Auto-canonicalize extracted figures.
**DoD:** a phone photo of a budget produces structured budget items in `pending_confirmation`; the original is preserved and access-controlled; confirming promotes to canonical with a human in the provenance chain; an instruction embedded in the document does not execute.
**CHECKPOINT 4.**

### Phase 5 — Billing & Entitlements (make the plans real)
**Goal:** the monetization model from the metering doc becomes enforceable.
**Do:** `plan` catalog (Free / Starter / Standard / Premium event packs; Pro / Business subs); `entitlement_grant` (event- and account-scoped); the **real `within_entitlement()`** replacing the Phase-1 stub (contributor limits, feature flags, credit balance); `sms_credit_ledger` with grants/reservations/commits/refunds; top-up purchases; the trial as a volume-gated free tier (≤25 contributors, 30 one-time SMS, phone-verified); `PaymentProvider` (Flutterwave) with **webhooks as the source of truth** for grants (idempotent); dunning/`past_due` handling for subs.
**Do NOT:** gate LLM usage for billing (meter only). Mark a plan active from the client. Bundle unlimited SMS into a flat fee.
**DoD:** adding contributor #26 on Free is blocked with an upgrade prompt; an SMS blast stops at the credit boundary; a paid MoMo charge (via webhook) grants credits/entitlements exactly once; a failed SMS refunds a credit; the free-tier cost exposure is capped by the ≤25/30-SMS/phone-verified rules. Tests cover both gates and the webhook idempotency.
**CHECKPOINT 5.**

### Phase 6 — Reporting, dashboards, hardening
**Goal:** the structured review surfaces (contributions grid, budget view, outstanding list — blueprint §2.1) and production hardening.
**Do:** read-optimized reporting queries (raw SQL where needed); dashboards for FINANCE/COORDINATOR; AI-observability views (token/cost, tool success rate, escalation rate); backup/restore verification; a first pass on DR and data-retention policy (these were deferred from the blueprint — now write them down); load-sanity on the SMS fan-out path.
**DoD:** a finance user can scan/sort/correct contributions in a grid without touching chat; reports export un-watermarked on paid tiers; backups are restorable (proven, not assumed); AI cost per event is visible.
**CHECKPOINT 6.**

### Explicitly deferred beyond this plan (do not build without a new decision)
Inbound SMS / MoMo-notification ingestion (the wedge — model for it, build later); WhatsApp; pgvector/vector DB; microservice extraction; Kafka/streaming; Kubernetes; multi-currency (unless §9 says otherwise); on-continent region; self-built OCR/auth/payments.

---

## 7. Definition of done — applies to every phase

- Automated tests cover the happy path **and** the invariant it must protect (RLS isolation, permission denial, idempotency, provenance, gate enforcement). A phase is not done because it "works in a demo."
- The invariants in §3 are demonstrably enforced by tests, not just present in code.
- No vendor SDK imported outside its provider interface.
- Migrations run cleanly forward; no destructive change to append-only tables.
- Structured logs + Sentry cover new error paths; no PII in logs.
- A short PR description states which phase, which DoD items it satisfies, and what it deliberately did *not* touch.

---

## 8. Coding principles

- **Boring and correct beats clever and broad.** Small PRs, one concern each.
- **Deterministic core, probabilistic edge.** Business rules and math live in typed services with unit tests. The LLM lives at the input/output edges only.
- **Everything external is behind an interface we own.** LLM, SMS, payments, storage, auth. No exceptions.
- **Transactions are sacred.** Mutation + audit + meter + outbox commit together or not at all.
- **Fail closed on the gates.** If permission or entitlement resolution errors, deny — never default-allow (except the intentional Phase-1 entitlement stub, which is removed in Phase 5).
- **Idempotency keys on every external side effect.**
- **Write the test that proves the invariant, then the code.**

---

## 9. Decide independently vs escalate

**Decide independently (don't wait):** framework specifics (NestJS module layout, DTO shapes), table/column naming, indexing, internal API shapes, test structure, error taxonomy, logging format, folder structure, library choices *within* the stack, prompt wording, tool schemas. These are reversible; make a reasonable call and move on.

**Escalate to the founder before proceeding (material, hard-to-reverse):**
1. **Supabase vs Neon/RDS** — the one open vendor call (metering doc + blueprint §8). If unresolved when you reach it, stay vendor-neutral behind interfaces and use plain managed Postgres.
2. **Multi-currency in V1** — UGX-only is the assumption; if diaspora KES/USD contributions must be first-class, the ledger's value modeling changes. Confirm before schema freeze.
3. **Any change that would put authority or business math in the LLM** — this violates the core principle; flag it rather than doing it.
4. **Introducing any deferred component** (Redis, vectors, a queue system, a new service, a second cloud) — requires an explicit decision with the reasoning framework in blueprint §27.
5. **Willingness-to-pay / final price points** — the numbers in the metering doc are estimates to be tuned against the first ~20 real events; don't hardcode them as immovable.

When you escalate, bring: the decision, the options, your recommendation, and the trade-off — not an open-ended question.

---

## 10. The one-paragraph brief, if you forget everything else

Build a permissioned, append-only ledger of event contributions in TypeScript on managed Postgres, one backend + one worker, five internal modules, RLS by event. Get the ledger correct *first* with typed inputs (Phase 1) — provenance, audit, permission gate, and a stubbed entitlement gate from the very first migration. *Then* layer the AI capture on top as a thin, structured-output, tool-calling interface that never computes or authorizes anything (Phase 2). *Then* SMS via the outbox and worker, idempotent and credit-aware (Phase 3). *Then* documents (Phase 4), *then* real billing and entitlements (Phase 5), *then* dashboards and hardening (Phase 6). Every external dependency sits behind an interface you own. Stop at each checkpoint and prove the invariants with tests before moving on. Do not build the deferred list. Do not put the model in charge of the truth.
