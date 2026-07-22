# Akabbo — AI Question Coverage Analysis

_Technical-founder coverage analysis of the AI layer against the real-world event-query test
suite (Parts 1–35). The goal is NOT to build every feature now — it is to confirm the V1
architecture does not **accidentally prevent** any of these, and to name the few genuinely
retrofit-painful gaps so they land in the foundation._

## Verdict

**Yes — this backend can grow into an AI that understands the whole lifecycle of a Ugandan
event, not just a payment list.** The canonical, grounded, audited domain model is already the
hard part and it exists. The dominant gap is **not data — it is read reach**: the AI can barely
_query_ what the ledger already knows (only `get_summary` + `get_outstanding` are read tools).
Most of Parts 1–7, 10, 13, 17–19, 25–26, 33 become answerable by adding a family of
**deterministic read/query tools** over data that is already there.

Three genuinely retrofit-sensitive gaps must be decided in the foundation (all **additive**, so
cheap if laid early, painful if bolted on after habits form): **contributor groups / family
sides**, **in-kind item description + delivery status**, and **conversation persistence**.

## The grounding principle (already enforced, keep it)

The AI is an **application-layer adapter** that calls the same permission-gated domain services
as the typed API — it has no privileged path. Every number comes from SQL; the LLM only
_phrases_ it (§3.8). The entity resolver **never guesses** ("which John?" → clarify). Writes land
as `pending_confirmation` for human promotion. This is exactly what Parts 30/32/33/35 demand, so
the answer to "what if the AI doesn't know" is structural: it has no way to invent — a read tool
returns rows or it returns nothing.

**Answer-honesty contract (Part 35).** Every AI answer is tagged by the source of its claim:

| Tag | Meaning | Backing |
|---|---|---|
| `FACT` | a grounded query result | SQL over canonical tables |
| `REPORTED` / `VERIFIED` | payment honesty | `fulfillment.verification_status` |
| `ESTIMATE` / `INFERENCE` | pace, projection, "will we make it" | computed, **labelled**, never stated as fact |
| `UNKNOWN` | no data | resolver/read tool returned empty → "I don't have that yet; here's what's needed" |

## Coverage matrix (by question category)

Legend — **V1?**: ✅ answerable now (data exists; needs read tool wiring) · 🟡 needs a small
additive model/tool · 🔴 needs a new subsystem (planned slice) · ⛔ deliberately out.

| Part | Category | Data today | Missing to answer | V1? |
|---|---|---|---|---|
| 1 | Event overview, totals, **time-based**, trend | pledges, fulfillments (`occurred_at`), event totals; `getEventReport` | time-range + trend **read tools** (group-by week/month, since-date); event `timezone` for boundaries (exists) | ✅ |
| 2 | Target vs actual, pace, projection | `target_amount`, pledged, received, outstanding | pace/projection = **ESTIMATE** tool (received ÷ elapsed vs days-to-`event_date`); must be labelled | ✅ |
| 3 | Contributor lookups, by method | person, pledge, fulfillment(`method`) | per-person + by-method read tools; **"from Entebbe" / "Sarah's family" = groups (P9)** | ✅ / 🟡 |
| 4 | Ambiguous names | `EntityResolver.resolvePerson` → "which John?" | context-narrowing ("the one from church") needs **conversation memory** + group data | ✅ / 🟡 |
| 5 | Pledge history: original vs latest, who changed | `audit_event` records every pledge correction old→new; `pledge.updated_at` | a **pledge-history read tool** over audit; optionally a `pledge_revision` view | ✅ |
| 6 | Budget: totals, per-item funding, gaps | budget_item(`target_value`,`is_public`), allocation, `getEventReport` gaps | per-item coverage read tools (projection math already built for public view) | ✅ |
| 7 | Budget×contribution intelligence ("can we afford") | pledge→`target_budget_item_id`, allocation | coverage/affordability read tools + "if all pledges clear" = **ESTIMATE** | ✅ |
| 8 | **In-kind / items**: who gives chairs, delivered? | `PledgeType.ITEM/SERVICE`, `FulfillmentKind.DELIVERY` | **`pledge.description`** ("chairs") + item **fulfillment/delivery status** + optional `estimated_value` | 🟡 |
| 9 | **Family / social groups / sides** | — none — | **`ContributorGroup` + membership** (FAMILY_SIDE/CHURCH/WORKMATES/CLAN/CUSTOM); never inferred | 🟡 |
| 10 | **"Who hasn't paid?"** | pledge status, outstanding = committed − Σ fulfillments | read tool with an explicit definition (no payment / partial / outstanding / unverified); clarify interpretation | ✅ |
| 11 | Reminders (filter→generate→preview→approve→send) | recipient data exists | **SMS domain** (message/campaign, cost-preview, send) — Slice G | 🔴 |
| 12 | SMS history ("who didn't receive", spend) | — none — | **SMS delivery tracking** tables — Slice G | 🔴 |
| 13 | Timeline: when created/pledged/paid/changed, who | `audit_event` (append-only, actor+source+time), row timestamps | audit read tools ("who added John", "who changed the budget") | ✅ |
| 14 | Document Q&A, extraction | FileObject/Document/Extraction (original+extracted+confidence+source) | budget extraction built; **contribution-list extraction** (`ExtractionKind.CONTRIBUTION_LIST` reserved) + doc-grounded Q&A tool | ✅ / 🟡 |
| 15 | Document ↔ ledger **reconciliation** | extraction rows + canonical ledger | **reconciliation pipeline** (extract→normalize→entity-resolve→diff→human review) | 🟡 |
| 16 | Photos: attach to person (NOT identify) | `FileObject` attaches to `person.files`, `FileKind.PROFILE_PHOTO` | attach tool; **auto face-ID stays ⛔** (privacy/consent) | ✅ / ⛔ |
| 17 | Committee: who can do what | `EventMember(role,status)`, permission matrix | member/permission read tools; "who is co-owner"; "not logged in recently" needs **session `last_seen`** (Slice E) | ✅ / 🔴 |
| 18 | Ownership, transfer | `event.owner_user_id`, roles | ownership read tool; **transfer = sensitive op** (Slice J) | ✅ / 🔴 |
| 19 | **Multiple events** (cross-event) | `listMyEvents` (runAsUser + own-membership RLS) | cross-event aggregate read tool, **own events only**; RLS already prevents leakage | ✅ |
| 20 | Event date / days-until / urgency | `event.event_date`, `timezone` | days-to-event + "unpaid & event next week" read tools; optional per-item/pledge **deadlines** (additive) | ✅ / 🟡 |
| 21 | Urgency synthesis ("what needs attention") | report + gaps + outstanding + date | a **synthesis read tool** feeding the LLM grounded signals (gaps, overdue, biggest balances) | ✅ |
| 22 | Kwanjula / introduction (item-heavy) | same spine | same as P8 (in-kind description + delivery) | 🟡 |
| 23 | Funeral / burial | same spine | none — event type is not hardcoded; works today | ✅ |
| 24 | Church / community, **recurring**, departments | groups (P9) | recurring contributions + departments = **future** (groups covers most) | 🟡 |
| 25 | Financial reconciliation ("why 9.5 not 10") | `audit_event`, `verification_status` | audit/diff read tools ("added today", "changed", "unverified", "no contributor") | ✅ |
| 26 | Trust / provenance ("who recorded this") | `audit_event` + `source` provenance + `verification_status` | provenance read tool surfacing the chain | ✅ |
| 27 | Subscription / seats vs contributors | `event_member` (seats = ACTIVE members); contributors are `person`, not seats | **billing/entitlement** real model — Slice I; seat/contributor split already correct | 🔴 |
| 28 | Closure lifecycle | `event.status` (DRAFT/ACTIVE/PAUSED/CLOSED/ARCHIVED) + write gate | pre-close report tool; final report; post-close corrections already gated | ✅ |
| 29 | NL variants ("paid"/"sent"/"cleared") | `CaptureService` + LLM intent | prompt/intent coverage (mostly done); "cleared/balance" → resolve to pledge outstanding | ✅ |
| 30 | Missing info / `200k` conventions | `amount.ts` (200k/1.5m); resolver clarifies | extend amount grammar ("200 thousand/grand"), UGX-vs-200 clarify already the pattern | ✅ |
| 31 | Currency (explicit USD) | `currency` on event + pledge | store `currency` on **fulfillment** too for mixed-currency; never assume UGX when stated | 🟡 |
| 32 | Refuse to guess | resolver never guesses; reads return empty | response contract: empty read → `UNKNOWN`, not a fabricated value | ✅ |
| 33 | Explain the answer | `getEventReport` already returns the components (by method, counts, unverified) | an **explain tool** returning the breakdown the LLM narrates | ✅ |

## The seven identifications (Part 34/35)

**1. Answerable in V1 (data exists; needs read tools only).** Parts 1, 2, 5, 6, 7, 10, 13, 19,
20, 21, 25, 26, 28, 29, 30, 32, 33 — plus the read-only slices of 3, 14, 17, 18. This is the
**biggest, cheapest win**: a deterministic read-tool family over the existing ledger + audit +
budget. No schema change.

**2. Requiring additional (additive) data models.** In-kind item **description + delivery
status** (P8/22), **contributor groups / family sides** (P3/9/24), fulfillment **currency**
(P31), optional **deadlines** (P20), **conversation persistence** (P4 context, P35 memory).

**3. Requiring document intelligence (extend Phase 4).** Contribution-list extraction (P14),
document↔ledger **reconciliation** (P15), doc-grounded Q&A ("what does the budget say about
catering", P14).

**4. Requiring advanced AI reasoning.** Urgency synthesis (P21), affordability/projection
(P2/7) — all built on grounded tool outputs and **labelled ESTIMATE**, never free-form.

**5. Requiring future subsystems (planned slices).** Reminders + SMS history (P11/12 → Slice
G), billing/seats (P27 → Slice I), ownership transfer + session activity (P17/18 → Slices E/J).

**6. Deliberately NOT supported initially (⛔).** Auto face-identification from a photo (P16 —
privacy/consent); marketing-style campaigns; inferring family/clan without explicit data.

**7. Questions that reveal missing architectural decisions.** Three, all to decide now because
they shape entities other things reference:
  - **Groups model** (P9): a generic, event-scoped `ContributorGroup` (`kind` enum incl.
    FAMILY_SIDE) + `person`↔group membership. Never inferred; only what a human/doc states.
  - **In-kind spine** (P8): does an ITEM pledge carry a `description` + `estimated_value`, and
    is delivery a `Fulfillment(kind=DELIVERY)` with its own status? (Recommended: yes to both.)
  - **Conversation state** (P4/35): `Conversation` + `Message` per event so multi-turn
    clarification ("the one from church") and "remembers everything" have somewhere to live.

## Recommended foundation moves (so nothing is prevented later)

Ordered by retrofit-pain, not by flashiness:

1. **Read-tool family (Slice F, expand).** `query_totals`, `query_collected_over_time`,
   `query_contributor`, `who_hasnt_paid`, `top_contributors`, `pledge_history`,
   `budget_coverage`, `audit_trail`, `explain_total`, `cross_event_summary`. All deterministic
   SQL; the LLM only narrates + tags FACT/ESTIMATE/UNKNOWN. **Unlocks ~17 categories with zero
   schema change.**
2. **Additive schema now (cheap, retrofit-painful later):** `pledge.description` +
   item/delivery status; `ContributorGroup` + membership; `fulfillment.currency`. Ship the
   columns even if the tools come later — the migrations are non-destructive.
3. **Conversation persistence (Slice F):** `Conversation`/`Message` for dialogue context and
   the "sat-with-the-committee" memory. Additive.
4. **Keep as their planned slices:** SMS/reminders (G), billing/seats (I), auth session
   activity (E), ownership transfer + contributor claiming (J), doc reconciliation (extend 4).

## The core question, answered

_"Can this backend eventually support an AI that genuinely understands the entire lifecycle of a
Ugandan event — not just a list of payments?"_

**Yes, and the expensive prerequisites are already in place:** provenance on every record,
append-only audit as the trust/timeline backbone, the pledge-vs-payment-vs-outstanding spine,
budget↔contribution linkage, honest REPORTED/VERIFIED, event-scoped RLS, and an AI that is
structurally forbidden from inventing. What remains is mostly **reach (read tools)** plus a
short list of **additive** models — none of which the current architecture blocks.
