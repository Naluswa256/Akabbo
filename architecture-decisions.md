# Akabbo — Architecture Decisions (First-Principles Analysis)

> **Status:** PROPOSAL v1 — my independent technical recommendation.
> **Basis:** the 5 captured documents in [knowledge-base.md](knowledge-base.md). I treated those as
> product owner *intent*, not specification. Where the specs conflict or are technically weak, I chose the
> approach I believe is correct for this product and this team and said why.
> **Author role:** acting principal engineer / technical decision-maker.
> **Date:** 2026-07-09.

---

## 0. TL;DR — the decisions

| # | Decision | In one line | Departs from spec? |
|---|----------|-------------|--------------------|
| D1 | **Two planes, not three tiers** | Cloudflare *edge* (delivery/cache/uploads) + **one** backend service. Collapse the "AI orchestration service" into the backend. | Yes — Docs #2/#3/#4 implied 3 services |
| D2 | **Backend = single modular monolith on Google Cloud Run** | Serverless container, scales to ~zero, co-located with the Google AI stack. NestJS + Prisma is fine. | Reconciles #1 vs #3 contradiction |
| D3 | **Postgres = managed serverless (Neon default)** | Normal pooled TCP from Cloud Run. The "Workers↔Postgres" problem *disappears* because DB code isn't on Workers. | Resolves the biggest open infra Q |
| D4 | **Do NOT partition the ledger yet** | Design partition-*ready*; single table + good indexes until ~10–20M rows. Partitioning now is premature. | Yes — Docs #1/#3 partition day 1 |
| D5 | **Async = pg-boss (Postgres queue) first; Cloud Tasks later** | No Redis (BullMQ), no dependence on Cloudflare Queues for core work. One less system to run. | Yes — Docs #1/#2 = CF Queues; #3 = BullMQ |
| D6 | **Public read plane stays exactly as designed** | Pages (static) + KV snapshot + edge cache. This is the best idea in the whole corpus; keep it. | No — affirmed |
| D7 | **R2 for all media/exports** | No-egress delivery of shareable exports; S3 API writes from Cloud Run. | No — affirmed |
| D8 | **AI = Google stack, but as in-process modules** | Gemini 2.5 Flash-Lite default + Document AI OCR + **Google STT V2 (drop Workers-AI Whisper)**. Conversation state in Postgres. | Resolves voice conflict; no separate service |
| D9 | **WhatsApp via Meta Cloud API direct + local SMS aggregator** | Avoid the AT $50/mo + BSP markup at low volume; keep SMS fallback separate. Revisit AT if it simplifies MoMo too. | Yes — Doc #1 assumed Africa's Talking |
| D10 | **Zero-custody = organizer attestation, OCR-assisted** | Be honest: Akabbo is a *bookkeeping/coordination* tool, not a payment verifier. Name the fraud model. | New — nobody specified the actual mechanism |
| D11 | **Recalibrate governance defaults down (500→~120 WhatsApp), per-lifecycle not monthly** | Restores fat margins at UGX 30k; makes P95 cost ~$2 vs $8.17 price. | Yes — Doc #5 defaults were too generous |
| D12 | **Auth: WhatsApp identity + short-lived dashboard JWT; public writes are rate-limited + moderated** | Contributors stay account-less; their ledger writes are *claims*, never confirmed truth. | Clarifies Doc #3 |

The through-line: **the corpus is a good product with an over-fragmented architecture.** Five documents
were each written to a different "engineering agent," so each invented its own service. A solo developer
cannot operate 3–4 long-lived services plus two clouds' worth of primitives. My job was to keep the good
ideas (edge read-plane, append-only ledger, AI-as-interpreter, governance) and **collapse the topology**
to something one person can actually build, debug, deploy, and afford.

---

## 1. Constraints that actually drive the design

Every decision below is derived from these, in priority order:

1. **Solo developer.** Operational surface is the scarcest resource, not CPU. Fewer services, fewer
   clouds, fewer stateful systems, one language, one deploy pipeline.
2. **Fixed low price: UGX 30,000 ≈ $8.17 per collection (one-time).** Variable cost per collection must
   stay a small fraction of that across the *whole distribution*, not just the median.
3. **WhatsApp-first, East Africa (Uganda).** Latency to users, MTN/Airtel money receipt formats,
   English/Luganda/Swahili, unreliable networks, SMS fallback.
4. **Zero-custody.** Akabbo never touches collection funds. This is a *legal/trust* posture and it
   fundamentally limits what "verification" can mean.
5. **Read-heavy & viral.** One organizer writes; hundreds of contributors read the same page. The read
   path must be near-free and never touch the primary DB.
6. **Correctness & auditability of the ledger.** It is money-adjacent; append-only, immutable, every
   mutation attributable.

When two documents conflict, whichever option best serves **(1) solo-operability** and **(2) unit
economics** wins.

---

## 2. D1 — Topology: two planes, not three tiers

**The central contradiction in the corpus:** Doc #1/#2 put *all* logic on Cloudflare Workers ("zero
long-lived app servers"); Doc #3 mandates a *separate long-lived NestJS container*; Doc #4 adds a *third*
"AI orchestration service." These cannot all be true.

**Decision:** there are **two planes and effectively two deployables**:

```
                         CONTRIBUTORS (100s per collection, viral)
                                        │  read-only, no login
                                        ▼
        ┌──────────────────────  CLOUDFLARE EDGE  ──────────────────────┐
        │  Pages (static contributor SPA)                                │
        │  KV (per-collection snapshot JSON)   ← the read plane          │
        │  R2 (uploads, exports, shareable images)                       │
        │  Edge cache + WAF + rate limiting + bot control                │
        │  (thin) Worker: serve snapshot, sign R2 uploads, proxy public  │
        │           writes to origin, optional webhook shield            │
        └───────────────────────────────┬───────────────────────────────┘
                                         │ public writes (pledge/claim), cache-miss rebuilds
                                         ▼
        ┌───────────────────────  BACKEND ORIGIN  ──────────────────────┐
        │  ONE modular monolith on Google Cloud Run (scales to ~zero)    │
        │  Modules: collections · ledger · pledges · claims · payments   │
        │           uploads · reminders · exports · audit · admin        │
        │           governance (usage metering/quota)                    │
        │           ai/ (orchestration: router, OCR, STT, extraction)    │  ← Doc #4 folded IN
        │           whatsapp/ (webhook + outbound)                       │
        │  pg-boss workers (async) run in the same service/image         │
        └───────┬───────────────────────┬───────────────────┬───────────┘
                │ pooled TCP             │ native GCP auth    │ S3 API
                ▼                        ▼                    ▼
        ┌───────────────┐      ┌──────────────────┐   ┌──────────────┐
        │ Postgres      │      │ Gemini / DocAI /  │   │ Cloudflare   │
        │ (Neon)        │      │ Speech-to-Text V2 │   │ R2           │
        └───────────────┘      └──────────────────┘   └──────────────┘
                                         ▲
                              ORGANIZER (1 per collection) via WhatsApp
```

**Why the "AI orchestration service" folds into the backend (rejecting Doc #4's separate service):**
the AI layer is a *pipeline of function calls* (route → OCR/STT → extract → validate → command). It shares
the command/entity schemas, the conversation-state table, and the governance checks with the backend.
Splitting it into its own service buys nothing but a network hop, a second deploy, duplicated schema
definitions, and distributed-tracing pain — for a solo dev that is pure cost. It becomes modules
(`ai/`, `ocr/`, `stt/`, `prompts/`) inside the monolith. If it ever needs independent scaling, Cloud Run
lets you split one module into its own service later *without a rewrite*.

**Why a container origin, not all-Workers (rejecting the pure Doc #1 reading):** the write path needs full
Node — Prisma transactions, the Google Cloud client libraries (native service-account auth), headless-
Chromium PDF/export rendering, multi-step LLM orchestration. All of these are *possible* on Workers but you
fight the platform (manual GCP JWT signing, Browser Rendering bindings, CPU-time limits, Prisma driver
adapters). On Cloud Run they are boring and well-trodden. **Crucially, Cloud Run still honors Doc #1's real
intent** — no fleet to babysit, autoscaling, atomic deploys, scale-to-zero billing. It is "serverless"
in every way that matters to a solo dev; the only concession is an occasional cold start on the *organizer*
path (never the contributor path, which is edge-cached).

**Why co-locate the origin on Google Cloud specifically:** the AI stack (Doc #4) is Google. Running the
backend on Cloud Run means AI/OCR/STT calls are in-region and use native workload-identity auth — no
cross-cloud egress, no hand-rolled service-account signing. Cloudflare stays doing what it is *uniquely*
best at (global static delivery + KV edge cache + no-egress R2), which is the genuinely brilliant part of
the design. We use each vendor for its strength instead of forcing one to do everything.

**Net:** 3–4 conceptual services → **2 deployables** (Cloudflare config + one Cloud Run image) + managed
Postgres. That is operable by one person.

---

## 3. D2 — Backend shape & framework

- **Modular monolith.** Keep Doc #3's module layout (`collections/`, `ledger/`, `pledges/`, `claims/`,
  `payments/`, `reminders/`, `exports/`, `audit/`, `governance/`, `ai/`, `whatsapp/`, `notifications/`).
  Boundaries are *module* boundaries, not network boundaries — refactor to services only when a real
  scaling or team reason appears (it won't for a long time).
- **Framework — DECISION UPDATED at M3 (2026-07-09): Hono-on-Node, not NestJS.** As the codebase took
  shape it settled into lean functional TypeScript (services as plain objects, pure domain functions, no
  DI container). NestJS's decorators/modules/DI would have been ceremony fighting that grain. **Hono-on-
  Node** matches the style, shares one framework with the edge Worker, and keeps the portability hedge
  (same handlers can move to Workers later). Prisma stays. This is exactly the merit-based override the
  brief invited — the original NestJS default was reconsidered against the actual code.
- **Language:** TypeScript everywhere (edge Worker + origin), one mental model.

---

## 4. D3 / D4 — Database & data model

**D3 — Engine: managed serverless Postgres, default Neon.** Postgres is unambiguously correct (it's a
ledger). Neon scales compute to zero, has branch-per-PR for cheap staging, and pooled TCP works normally
from Cloud Run. Cloud SQL is the alternative if data-residency/legal forces a specific region (see open
confirm #B). **The entire "how do Workers hold a Postgres connection" question is dissolved** by D2 — the
only code that touches Postgres runs on Cloud Run, which pools connections the normal way.

**D4 — Partitioning: defer it.** Docs #1/#3 partition `ledger_events` by `hash(collection_id)` +
monthly subpartitions *on day one*, justified by a 100M-row projection. A solo dev at launch has zero
collections. Postgres handles 100M rows in a single table comfortably with the right indexes; partitioning
adds real complexity (partition management, cross-partition query care, migration friction) for a payoff
years away. **Decision:** design *partition-ready* now — `collection_id` on every table, append-only
ledger, no cross-collection scans, monotonic keys — and introduce declarative hash partitioning behind a
migration when the ledger actually approaches ~10–20M rows. This is a reversible, well-signposted decision,
not a door we close.

**Reconciled canonical schema** (merging Doc #1 §3 and Doc #3 §8–13; resolving the discrepancy flagged at
capture):

| Table | Purpose | Key notes |
|-------|---------|-----------|
| `organizers` | WhatsApp identity | `phone_number`, `whatsapp_id`, `name` |
| `collections` | campaign + lifecycle | `public_id` (high-entropy, non-enumerable), `status`, trial/subscription fields, `goal_amount` **BIGINT minor units**, `currency`, `end_date`, `snapshot_version` |
| `contributors` | per-collection people | account-less; `name`, `phone` |
| `pledges` | promises | `amount`, `due_date`, `status` |
| `payment_claims` | "I paid" attestations | `amount`, `reference`, `channel`, `status` (PENDING/CONFIRMED/REJECTED) |
| `ledger_events` | **append-only source of truth** | `event_type`, `amount`, `actor`, `metadata jsonb`, `created_at`; never updated/deleted |
| `uploads` | R2 object metadata | `file_hash` (dedupe), `file_type`, `ocr_status`, `confidence` |
| `notifications` | outbound intent (outbox) | `recipient`, `channel`, `template`, `status`, `sent_at` |
| `notification_limits` | per-recipient frequency | `last_sent`, `count` (reminder anti-spam) |
| `reminders` | schedule state | pledge-centric |
| `conversation_sessions` | **multi-turn WhatsApp state** | `organizer_id`, `flow`, `collected jsonb`, `waiting_for`, `expires_at` |
| `usage_events` | metering | `resource`, `quantity`, `estimated_cost`, `metadata` |
| `usage_balances` | per-collection quota | `resource`, `used`, `limit`, `reset_at` |
| `usage_policies` | configurable limits | `resource`, `soft_limit`, `hard_limit`, `rules jsonb` |
| `audit_log` | every mutation | `actor`, `source`, `reason`, `timestamp` |
| `processed_events` | idempotency | `event_id` unique; dedupe WhatsApp/webhook retries |

- **The public snapshot is NOT a heavy Postgres table.** It lives in **KV** (source rebuildable from
  Postgres). `collections.snapshot_version` drives cache invalidation. This removes the redundant
  `collection_public_snapshot` table.
- **Money = `BIGINT` minor units + explicit `currency`.** UGX has no minor unit → store integer UGX;
  the generic minor-unit convention keeps multi-currency clean later. **Never floats for money.**
- **`REMOVE_PLEDGE` / `EDIT_PLEDGE` / `DELETE_COLLECTION` become events, not row deletes** — the ledger is
  immutable. "Delete collection" = `ARCHIVED` status; pledge edits = adjustment events. (Closes the Doc #4
  vs Doc #3 immutability conflict.)

---

## 5. D5 — Async jobs & cron

Three options were on the table: Cloudflare Queues (Doc #1/#2), BullMQ/Redis (Doc #3), Cloud Tasks.

**Decision: pg-boss (a Postgres-backed job queue) inside the Cloud Run service, initially.** Rationale:
- **No new infrastructure.** It reuses the Postgres we already run — no Redis to operate (BullMQ's cost),
  no cross-plane coupling to Cloudflare Queues for core write-path work.
- Gives retries, scheduling, dead-letter, and exactly-once-ish semantics — enough for OCR/AI/notification/
  export/reminder jobs at this scale.
- Job producers and consumers share the same codebase, schemas, and DB transaction — you can *enqueue in
  the same transaction that writes the ledger*, which is a real correctness win (no lost jobs on crash).

**Graduation path:** if job volume outgrows Postgres (unlikely for a long time), move to **Cloud Tasks**
(HTTP push, native to Cloud Run, scales to zero). **Cron = Cloud Scheduler** hitting internal endpoints
that only *enqueue* (honoring Doc #2's "cron publishes jobs, never does heavy work"). Cron jobs:
`reminders`, `trial-expiration`, `collection-close`, `snapshot-cleanup`, `retry-failed`, `tmp-cleanup`,
`analytics-rollup`.

**Cloudflare Queues** is retained only if we later add edge-originated async (e.g. webhook shielding at the
edge). Core async does not depend on it.

**All consumers idempotent** via `processed_events(event_id)` — kept from Docs #2/#3.

---

## 6. D6 — Public read plane, cache & snapshots (affirmed)

This is the strongest idea in the corpus and I'm keeping it essentially unchanged:

- Contributor app = **static** (Pages), hydrates from **snapshot JSON in KV**. 500 people opening a link →
  ~1 KV read, 0 Postgres queries.
- **Write→snapshot→cache flow:** origin writes Postgres (in a transaction) → enqueues a snapshot-rebuild
  job → job composes snapshot JSON → writes KV under `collection:{public_id}:v{n}` and updates
  `snapshot_version` → purges edge cache. Versioned keys make invalidation atomic and give instant
  rollback (serve `v(n-1)` if a rebuild fails — Doc #2's "serve previous snapshot").
- Snapshot = **current state only** (totals, progress, verified contributors, pending claims, recent
  activity), never history. History is a separate, authenticated, paginated origin query for the organizer.

---

## 7. D7 — Storage & media (affirmed, with one clarification)

- **R2 for everything** (payment screenshots, budgets, voice notes, PDFs, exports, summary images).
  No-egress delivery matters because **exports/summary images get reshared in WhatsApp groups** and
  downloaded many times. Cloud Run writes via the S3-compatible API (tiny one-way upload egress only).
- **Two ingestion paths, and they differ** (clarifying Doc #2, which only described the web path):
  - **Web dashboard uploads:** browser → signed R2 URL (edge Worker signs) → direct to R2 → enqueue OCR.
  - **WhatsApp media:** the message only carries a media ID. The **backend pulls** the binary from the
    Meta/BSP media endpoint (short-lived URL), stores to R2, then enqueues OCR. This is server-side fetch,
    not a signed browser upload.
- **Dedupe by `file_hash`** before OCR (Doc #4 §24) — real money saver on re-sent screenshots.
- Objects **private**; lifecycle policy expires `tmp/` and raw OCR inputs; exports kept for the collection
  lifetime + grace.

---

## 8. D8 — AI intelligence layer

**Decision: Google-first, but as in-process modules (not a separate service — see D1).**

- **LLM:** Gemini 2.5 Flash-Lite as default router/extractor; escalate to Gemini 2.5 Flash (or Pro for
  final summaries) only when confidence < threshold or input is messy. Use **structured-output / JSON-
  schema mode** for all commands — no free-form text reaches the backend.
- **OCR:** Document AI Enterprise OCR. **"OCR first, LLM second"** is retained — it's genuinely the
  cost-right pattern. A **deterministic parser** handles MTN/Airtel receipt layouts; the LLM is only a
  repair pass for low-confidence/handwritten cases.
- **Voice: Google Speech-to-Text V2 (Chirp 3). Drop Workers-AI Whisper** (resolving the Doc #1 vs Doc #4
  conflict) — we're already on GCP with native auth, Chirp 3 handles code-switching + noisy audio, and it
  keeps one AI vendor.
- **Confidence thresholds (unified):** ≥0.95 auto-proceed · 0.70–0.94 one-tap confirm · <0.70 clarify.
  (Doc #1's ">95%" and Doc #4's "≥0.95" reconcile here.)
- **Conversation state → Postgres (`conversation_sessions`).** This closes Doc #4's biggest gap (it demanded
  persisted state but never said where). Postgres, not Durable Objects (which Doc #2 says avoid) and not KV
  (eventually consistent — wrong for read-modify-write session updates). WhatsApp can redeliver/reorder, so
  session updates are transactional with an idempotency key. Per-organizer message rate is tiny; Postgres
  is more than fast enough. Add a short-TTL in-memory/Redis cache only if a hot-path need ever appears.
- **Prompts = versioned assets** in the repo (a `prompts/` registry), never inlined — kept from Doc #4.
- **Shared command/entity schema is a single source of truth** (one package / JSON Schema) consumed by
  both the `ai/` modules and the ledger validator — no drift (closes the Doc #3↔#4 `extractedData` gap).
- **The deterministic validator sits between AI and the ledger, always.** AI proposes commands; the
  backend validates arithmetic, permissions, quotas, and idempotency before any `ledger_event`. AI never
  does money math. (Affirmed from Docs #3/#4 — this is correct and non-negotiable.)

---

## 9. D9 — Messaging / WhatsApp BSP

> **REVISED BY OWNER DECISION (2026-07-09): Twilio is the WhatsApp BSP.**
> After M3 shipped on Meta direct, the owner chose Twilio despite the cost analysis below. Implemented via
> an explicit provider seam (`backend/src/whatsapp/provider.ts` + `providers/twilio/`, `providers/meta/`):
> Twilio is the default (`WHATSAPP_PROVIDER=twilio`), Meta is retained as a working alternative.
> - **Mechanics that changed:** inbound is form-encoded (one message per webhook) with `X-Twilio-Signature`
>   (HMAC-SHA1 over exact-URL + sorted params — requires `TWILIO_WEBHOOK_URL` config since we run behind
>   proxies); outbound via Messages API (basic auth, `whatsapp:+…` addressing); interactive buttons require
>   a pre-created Content template (`twilio/quick-reply`, `ContentSid` + variables; no approval needed
>   in-session; graceful degrade to text when unconfigured); replies to webhooks are empty TwiML.
> - **Capability parity:** everything Akabbo uses is retained (24h-window free-form replies, quick-reply
>   buttons, inbound media for M4 OCR/voice, templates for out-of-window reminders, delivery callbacks).
> - **Cost impact (recorded honestly):** Twilio adds **$0.005/message inbound AND outbound** on top of
>   Meta passthrough. The organizer conversation is no longer free (~30–60 msgs/collection ≈ $0.15–0.30
>   toll) and out-of-window utility reminders cost ~$0.009 vs $0.004. Estimated P50 rises from ~$0.21 to
>   **~$0.45–0.55**, P95 from ~$1.19 to **~$2.3–2.8** — still comfortably profitable against $8.19, with
>   margin ~93% (P50) / ~68% (P95). What Twilio buys: faster sandbox/dev loop, one console for
>   WhatsApp+SMS (fallback can consolidate), simpler media fetch, easier sender onboarding.
> - The rest of this section documents the original Meta-direct analysis for the record.

Doc #1 assumed **Africa's Talking**; Doc #2 kept it generic.

**Original decision (superseded above):** start on **Meta WhatsApp Cloud API direct** for WhatsApp +
a **local SMS aggregator** (Africa's Talking *or* a Ugandan SMS gateway) for fallback only.

- **Why not AT for WhatsApp:** AT's cited **$85 setup + $50/month maintenance** plus per-message BSP markup
  is a real fixed cost that hurts badly at low launch volume (it alone is ~6 collections/month just to
  break even on the platform fee). Meta Cloud API has **no monthly platform fee** — you pay per message and
  can self-onboard a number.
- **Why keep SMS separate:** SMS is fallback-only; a thin local aggregator integration is cheap and
  independent.
- **Where AT could still win:** if it also cleanly provides the **Mobile Money collection** for the UGX
  30,000 platform fee (see D10/D11), one vendor for WhatsApp+SMS+MoMo might beat three integrations for a
  solo dev. That trade is the open confirm.
- **Message-cost discipline is the real lever, regardless of BSP** (see D11): pledge-centric reminders,
  hard frequency caps, prefer user-initiated *service* window replies (cheap/free) over paid *template*
  sends, and **never** use the *marketing* category ($0.032 — 4× utility).

> ✅ **Prices VERIFIED against primary/current sources on 2026-07-09 — see Appendix A.** The corpus's
> WhatsApp assumptions were stale (per-message model since Jul 2025; service free since Nov 2024; utility
> Rest-of-Africa now $0.004 not $0.008). Verified rates *improve* the economics (D11c). Provider prices
> shift quarterly — re-check Appendix A before any pricing/margin commitment more than ~a quarter old.

---

## 10. D10 — Zero-custody verification (the product-critical decision nobody specified)

Every document *asserts* zero-custody but **none define what "payment verification" actually is** when the
platform never sees the money. This is the core product and trust question, so I'm naming it explicitly.

**Model:** Akabbo is a **bookkeeping & coordination tool, not a payment processor.** The truth of "money
moved" lives between contributor, telco, and organizer. Akabbo records *attestations and confirmations*:

1. Contributor pays the organizer directly (Mobile Money / cash) — **outside Akabbo**.
2. Contributor (or organizer) submits a **claim** ("I paid UGX X, ref MP123456") — optionally with a
   receipt screenshot. This is a `PAYMENT_CLAIMED` event, status `PENDING`. **It is not truth yet.**
3. OCR + AI *assist* the organizer by extracting sender/amount/ref from the screenshot and flagging
   mismatches. **This is decision support, not proof** — a screenshot can be faked or reused.
4. The **organizer confirms or rejects** (they can see their own MoMo balance/SMS). Confirmation writes
   `PAYMENT_CONFIRMED`. **Human attestation by the fund recipient is the verification.**

**Consequences I'm making explicit:**
- **Fraud surface:** forged/duplicated screenshots. Mitigations: `file_hash` + reference dedupe (same
  receipt can't be claimed twice), amount/sender cross-checks, and flagging duplicates for the organizer.
  Residual risk is inherent to zero-custody and must be *communicated to organizers*, not hidden.
- **Future hard-verification** (Doc #21 roadmap): direct **MTN MoMo / Airtel Money reconciliation APIs**
  can later turn attestation into cryptographic confirmation where the organizer opts in. Architect the
  `payments/` module so a `verification_source` field (`ORGANIZER_ATTESTED` | `MOMO_API_CONFIRMED`) is
  present from day one.
- **Legal framing:** because Akabbo never holds funds, it likely sits *outside* money-transmitter/PSP
  licensing — but the UGX 30,000 *platform fee* Akabbo collects for itself **is** a payment Akabbo
  receives (see D11), and that path may need a PSP/aggregator. **Do not conflate the two money flows.**

---

## 11. D11 — Governance & economics recalibration

**The problem I flagged at capture:** Doc #5's default allowances (500 WhatsApp, 100 SMS, 500 reminders,
etc.) describe a *worst-allowed* case ~17× larger than Doc #1's *expected* case (32 messages). At the
ceiling a collection could cost **$5–7** against a **$8.17** price — thin, and blowable by marketing-
category sends or heavy AI escalation. Two documents were modeling different risk regimes.

**Decisions:**

**(a) Budgets are per-collection-lifecycle, NOT monthly-resetting.** Doc #5's "monthly allowance" +
`reset_date` against a one-time UGX 30,000 purchase makes the cost ceiling unbounded over time (a
year-long collection would reset its 500-message budget 12×). A one-time purchase gets a one-time budget.
Long-running or heavy collections buy **top-ups** (a clean upsell). `usage_balances.reset_at` is repurposed
as an optional top-up boundary, not an automatic monthly refill.

**(b) Lower the defaults to protect margin.** Recommended per-lifecycle defaults (all configurable via
`usage_policies`):

| Resource | Doc #5 default | **My default** | Why |
|----------|---------------|----------------|-----|
| WhatsApp template/utility msgs | 500 | **120** | biggest cost lever; pledge-centric reminders keep real usage well under this |
| WhatsApp service (user-initiated window) | — | **generous/uncapped** | cheap/free; don't throttle helpful replies |
| SMS fallback | 100 | **30** | fallback only |
| AI interactions | 100 | **150** | Flash-Lite is cheap; don't starve the core UX |
| OCR pages | 100 | **60** | dedupe + deterministic parser reduce real usage |
| Reminders (scheduled) | 500 | **120** | 1/48h per contributor cap does the real work |
| Manual broadcasts | 3 | **3** | keep — good anti-spam |
| Exports | 10 | **5** | plenty |

**(c) Recomputed unit economics — using VERIFIED July-2026 rates (see Appendix A).**

The verification pass materially *improved* the picture versus the corpus, because WhatsApp got cheaper
since Doc #1 was written. Two structural wins:
- **Organizer ↔ bot messaging is FREE.** The organizer always initiates, so the 24h *customer-service
  window* is open — service messages are free (since Nov 2024) and utility templates inside the window are
  free. The entire chatty organizer path costs $0 in messaging.
- **The only paid WhatsApp messages are templates sent to contributors *outside* a window** (mainly
  reminders + some confirmations), now **$0.004** each (utility, Rest of Africa) — half the corpus's
  $0.008. Marketing ($0.0225) is 5.6× utility → **never use it**.

Price = UGX 30,000 ÷ 3,663 = **$8.19**.

| Case | Paid WhatsApp (utility, out-of-window) | SMS fallback | AI (Flash-Lite) | OCR | STT | **Variable cost** | % of $8.19 |
|------|------|-----|-----------------|-----|-----|--------------------|-----------|
| **P50** (~20 contributors) | ~35 × $0.004 = $0.14 | 3 × ~$0.009 = $0.026 | ~$0.02 | 15 × $0.0015 = $0.022 | ~$0.003 (batch) | **~$0.21** | ~2.6% |
| **P95** (100+, chatty) | ~180 × $0.004 = $0.72 | 30 × ~$0.009 = $0.26 | ~$0.10 (+esc.) | 60 × $0.0015 = $0.09 | ~$0.02 | **~$1.19** | ~14.5% |

Even the near-ceiling P95 collection leaves **~85% gross margin**; P50 leaves **~97%**. Fixed platform
costs (Cloud Run scale-to-zero ≈ $0–15/mo, Neon free→$19/mo, Cloudflare ~$5/mo, R2 pennies at this volume)
amortize to cents once there are dozens of collections/month. **The UGX 30,000 price is comfortably
profitable across the entire usage distribution** — the earlier concern (Doc #5 ceiling ≈ price) is fully
resolved, and it was the *unverified* WhatsApp rate that made it look tight.

**Implication for governance defaults:** the D11(b) caps (120 WhatsApp, etc.) are now conservative on pure
cost grounds — at $0.004/msg even 500 messages is only $2. **Keep the caps anyway**, because reminders are
the *abuse/annoyance* vector (spamming contributors damages the product) more than a cost vector. The cap's
job is user-experience and anti-abuse, not just margin.

**(d) Governance placement:** it's cross-cutting middleware **in the backend** (a `governance/` module +
a guard invoked before any billable action: AI, WhatsApp, OCR, reminder, export). Metering writes go
through pg-boss batching to avoid a `usage_events` write per message becoming a hotspot. Not an edge
concern — the edge doesn't originate billable actions.

**(e) Platform-fee collection ≠ collection funds.** Charging UGX 30,000 needs a **Mobile Money collection
integration** (MTN MoMo Collections / Airtel / or an aggregator like Flutterwave/Pesapal/DPO). This is
Akabbo's *own* revenue and is entirely separate from the zero-custody collection contributions. Trial →
paid transition (Doc #3 §21) triggers this charge; after trial + unpaid, the collection goes read-only.

---

## 12. D12 — Security & auth

- **Organizer auth = WhatsApp identity** (phone/`whatsapp_id` proven by the fact the message arrived over
  the verified WhatsApp webhook) **+ short-lived JWT** minted for the optional web dashboard via a
  WhatsApp-delivered one-time code / magic link. Refresh via re-auth over WhatsApp. (Closes Doc #3's
  under-specified JWT flow.)
- **Contributors: no accounts.** Their public writes (`pledge`, `payment_claim`) are **claims, never
  confirmed truth** (see D10), are **edge rate-limited + bot-checked** (Turnstile), and are moderated by
  the organizer before affecting verified totals. Public `public_id` is **high-entropy, non-enumerable**
  (not sequential), which also gates casual scraping.
- Standard controls (affirmed from Docs #2/#3): webhook signature verification, strict CORS + CSP, security
  headers, parameterized queries (Prisma), least-privilege service credentials (GCP workload identity),
  encryption of sensitive fields (phone numbers) at rest, immutable `audit_log`, secrets in
  Secret Manager / Wrangler secrets (never committed).
- **Idempotency everywhere** external events enter (`processed_events`) — WhatsApp retries must never
  double-write ledger/notifications/payments.

---

## 13. D13 — Deployment, environments, developer experience

- **Two deploy targets, one pipeline:** `git push` → CI (typecheck, unit, integration) → build Cloud Run
  image + deploy (Cloud Run revisions give instant rollback + traffic splitting for zero-downtime) →
  deploy Cloudflare Pages/Worker via Wrangler → run DB migrations (Prisma migrate) → smoke tests → shift
  traffic. Cloud Run revision traffic-splitting *is* the blue/green mechanism (simpler than Doc #2/#3's
  hand-rolled "traffic switch").
- **Three environments** (dev/staging/prod) with isolated KV/R2/queues/secrets/DB — affirmed from Doc #2.
  Neon branches make ephemeral staging DBs cheap.
- **Local DX:** docker-compose Postgres + pg-boss, a WhatsApp webhook simulator, an AI-pipeline simulator
  (Doc #4's "local simulation tools"), seed data. One `make dev`.
- **Repo shape:** a single monorepo — `edge/` (Worker + Pages), `backend/` (the monolith),
  `packages/contracts/` (shared command/entity JSON schemas + types consumed by both), `infra/`
  (Wrangler + Terraform/Cloud config), `prompts/`.

---

## 14. D14 — Observability (affirmed, consolidated)

Structured JSON logs with `requestId`/`traceId`/`collectionId` (no PII in logs). Metrics: worker + origin
latency, queue depth/retries, KV & edge cache hit ratio, OCR success + confidence distribution, AI cost &
model-routing distribution per collection, webhook latency/failures, reminder delivery, payment-
confirmation rate. Alerts on webhook-failure spikes, queue backlog, DB CPU, storage thresholds, OCR
confidence degradation, and **per-collection cost anomalies** (a governance early-warning). `/health`,
`/readiness`, `/metrics` on the origin; the edge Worker exposes a health route.

---

## 15. Explicitly deferred (YAGNI for launch)

Building these now would burn a solo dev's time for no near-term return:
- Ledger **partitioning** (D4) — until ~10–20M rows.
- **Durable Objects** — Doc #2 already says avoid; conversation state is in Postgres (D8).
- **Multi-region Postgres replicas / data residency replication** — until a legal or latency need is real.
- **Cloudflare Queues** as core async — pg-boss covers it (D5).
- **CDC / real-time analytics dashboards** (Doc #21) — batch `analytics-rollup` cron is enough.
- **MoMo hard-verification APIs** — architect for it (D10 `verification_source`), build later.
- **Offline-first PWA** — the static+KV read path already degrades gracefully.
- **A separate AI service / a separate governance service** — modules, not services (D1).

---

## 16. Recommended build order (milestones)

1. **M0 — Skeleton:** monorepo, Cloud Run hello-world, Neon, Prisma schema + migrations (canonical model
   from D3), Cloudflare Pages/Worker + KV/R2 bindings, CI/CD, three environments.
2. **M1 — Ledger core:** collections, organizers, append-only `ledger_events`, pledges, claims, the
   deterministic validator, audit log, idempotency. No AI yet — prove correctness with tests.
3. **M2 — Public read plane:** snapshot rebuild job → KV → static contributor page. Prove 0-DB reads.
4. **M3 — WhatsApp write plane:** Meta Cloud API webhook, command dispatch, `conversation_sessions`,
   outbound notifications, START→create-collection happy path.
5. **M4 — AI layer:** Document AI OCR + deterministic receipt parser + Gemini extraction + confidence
   engine + clarification buttons. STT for voice. All behind the validator.
6. **M5 — Governance & billing:** metering, quotas, staged soft-limits, MoMo platform-fee collection,
   trial→paid→read-only lifecycle.
7. **M6 — Reminders, exports, admin:** pledge-centric reminder engine, PDF/image exports to R2, admin
   controls, observability dashboards.

Each milestone is shippable and testable on its own.

---

## 17. Open-questions resolution (all 29 from capture)

| # | Item | Resolution |
|---|------|-----------|
| 1 | Schema discrepancy (Doc#1 vs #3) | **Resolved** — canonical schema, D3 table. |
| 2 | Africa's Talking capabilities | **Decision** — Meta Cloud API direct + local SMS; D9. Verify prices. |
| 3 | Zero-custody legal framing | **Named** — D10; PSP only for platform fee, not collection funds. |
| 4 | Monetization/trial model | **Defined** — UGX 30k one-time, trial→paid→read-only; D11. |
| 5 | Confidence thresholds inconsistency | **Unified** — ≥0.95/0.70/<0.70; D8. |
| 6 | Unit-economics assumptions | **Recomputed** as a distribution; D11(c). |
| 7 | Workers↔Postgres connection | **Dissolved** — DB code on Cloud Run, not Workers; D2/D3. |
| 8 | 7-Worker split | **Rejected** — thin edge Worker + one origin monolith; D1. |
| 9 | WhatsApp BSP ambiguity | **Decision** — Meta direct (confirm #C); D9. |
| 10 | Backend tier ownership gap | **Resolved** — one origin service; D1/D2. |
| 11 | **Topology contradiction (#1 vs #3)** | **Resolved** — two planes, Cloud Run origin; D1. |
| 12 | Queue tech split | **Decision** — pg-boss; D5. |
| 13 | Duplicated domain ownership | **Assigned** — backend owns snapshot/notif/reminder/audit; edge only caches; D1/D6. |
| 14 | public_id scheme | **Decision** — high-entropy non-enumerable; D3/D12. |
| 15 | amount typing | **Decision** — BIGINT minor units + currency; D3. |
| 16 | Auth model | **Defined** — WhatsApp identity + short-lived JWT; public writes rate-limited claims; D12. |
| 17 | Three service tiers | **Collapsed** to two deployables; D1. |
| 18 | Voice provider conflict | **Decision** — Google STT V2, drop Whisper; D8. |
| 19 | AI vendor concentration | **Accepted & leveraged** — origin on GCP co-locates AI; D1/D2. |
| 20 | Conversation-state store | **Decision** — Postgres `conversation_sessions`; D8. |
| 21 | Shared extractedData schema | **Decision** — one `packages/contracts` source of truth; D8/D13. |
| 22 | Prices/models to verify | **Flagged** — verify before locking; D9 warning. |
| 23 | DELETE vs immutability | **Resolved** — soft-archive + adjustment events; D3. |
| 24 | Pricing fixed UGX 30k | **Recorded** ≈ $8.17; D11. |
| 25 | Allowance ceiling ~17× cost model | **Resolved** — lower defaults; D11(b). |
| 26 | Monthly vs one-time | **Decision** — per-lifecycle budget + top-ups; D11(a). |
| 27 | Trial/paid/governance state machine | **Defined** — D11(e)/D12. |
| 28 | Governance placement | **Decision** — backend middleware; D11(d). |
| 29 | estimated_cost currency/FX | **Decision** — versioned rate+FX config table; D11/D14. |

Nothing dropped.

---

## 18. Foundation decisions — CONFIRMED by owner (2026-07-09)

- **A. Vendor topology → CONFIRMED: Cloudflare edge + Google Cloud Run origin** (two planes, each vendor
  for its strength). D1/D2 stand as written.
- **B. Data residency → CONFIRMED: no hard residency rule at launch.** Use **Neon** (scale-to-zero, cheap
  staging branches) in a nearby region. Documented as a risk to revisit with legal before scale / before
  handling large volumes of real user data.
- **C. Messaging/MoMo → CONFIRMED: Meta WhatsApp Cloud API direct + separate local SMS aggregator + MoMo
  aggregator** for the UGX 30k platform fee. D9 stands. Build the messaging layer behind a provider
  interface anyway so the BSP is swappable, and re-verify all rates before locking economics.

**Foundation is locked.** Next step is implementation starting at **M0 → M1** (§16), unless you want to
review any specific decision first.

---

## Appendix A — Verified pricing (checked 2026-07-09)

All figures verified against current primary/secondary sources on 2026-07-09. Provider rates change
(WhatsApp updates quarterly); re-verify before any external pricing/margin commitment.

| Item | Verified value (Jul 2026) | vs. corpus | Source |
|------|---------------------------|-----------|--------|
| **WhatsApp — model** | Per-message since Jul 1 2025 (conversation pricing deprecated). Non-template messages free. | Corpus pre-dated this | Meta developer docs; YCloud; Twilio changelog |
| **WhatsApp — service msgs** | **FREE** for all businesses since Nov 1 2024 | Corpus said $0.002 | Meta developer docs |
| **WhatsApp — utility in open 24h service window** | **FREE** | New | Meta developer docs |
| **WhatsApp — utility (Rest of Africa, out-of-window)** | **$0.004** / msg | Corpus $0.008 (½) | flowcall pricing table |
| **WhatsApp — authentication (Rest of Africa)** | **$0.004** / msg | Corpus $0.008 | flowcall |
| **WhatsApp — marketing (Rest of Africa)** | **$0.0225** / msg (avoid) | Corpus $0.032 | flowcall |
| **Uganda = "Rest of Africa" region** | Confirmed grouping | Consistent | multiple |
| **Document AI Enterprise OCR** | **$1.50 / 1k pages** (1–5M/mo), **$0.60 / 1k** (>5M) | Matches corpus ✓ | Google Cloud Document AI pricing |
| **Document AI Layout Parser** | $10 / 1k pages | Matches corpus ✓ | Google Cloud |
| **Gemini 2.5 Flash-Lite** | **$0.10 / M input, $0.40 / M output** (cheapest Google model) | Corpus unnamed; confirmed cheapest | Google AI pricing; aggregators |
| **Speech-to-Text V2 (Chirp)** | Realtime **$0.016/min** (first 500k min); **Dynamic Batch $0.003/min** | Corpus $0.016/min; batch is 5× cheaper — use batch for async voice notes | Google Cloud STT pricing |
| **USD/UGX FX** | ~**3,663** (Jul 1 2026); 2026 avg ~3,670 | Corpus 3,670 ✓ | Wise; exchange-rates.org |
| **UGX 30,000 price** | = **$8.19** | Corpus ~$8.17 ✓ | derived |
| **MTN MoMo Pay (merchant collection)** | Merchant payments **free to payer**; 0.5% govt levy on *withdrawals* only | New — favorable for platform-fee collection | basketadvisory; momocalc |
| **Uganda SMS** | ~UGX 19–35 / SMS (~$0.005–0.010) | Matches corpus ✓ | corpus + market rates |
| **Note — newer LLMs exist** | Gemini 3 Flash (~$0.50/M) etc. now available; 2.5 Flash-Lite remains cheapest for extraction/routing | — | aggregators |

**Not separately priced (small fixed/near-zero, ballparks):** Cloud Run (scale-to-zero, ~$0 idle, pay per
request), Neon (free tier → ~$19/mo), Cloudflare Workers ($5/mo) + KV/R2 (R2 $0.015/GB-mo storage, **no
egress**). These are minor vs. the variable drivers above and don't affect the profitability conclusion.

**Still to confirm with the actual providers before launch (commercial, not architectural):**
- MoMo **merchant/aggregator commission** on collecting the UGX 30,000 (MoMo Pay is free to the payer, but
  a merchant discount rate or aggregator fee — e.g. Flutterwave/Pesapal ~2–3% — may apply on settlement).
- WhatsApp **volume-tier discounts** on utility/auth (rates drop with volume) — upside, not risk.
- Exact Uganda SMS rate from the chosen aggregator (telco + volume dependent).
