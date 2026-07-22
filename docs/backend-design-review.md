# Akabbo — Backend Design Review (post-simulation)

**Status:** design record, written after the end-to-end usage simulation. Companion to
the three founding docs (blueprint, monetization, CLAUDE.md build plan). This file is
the canonical reference the remaining phases cite. It does not replace the phased plan;
it corrects the domain model and inserts a **Phase 1.5 (identity foundation)** before
Phase 3.

---

## 0. The foundational decision: three identities, one linkage

`User`, `EventMember`, and `Person` are distinct. `Person.user_id` (nullable) is the
hinge that links them **without creating a duplicate**.

```
USER (auth identity: phone, verified, name)      ← nullable for a Person
  └─ EVENT_MEMBER (user × event × role × status)  ← the ~15 team; seat-counted
        operates on ↓
EVENT (status, target, date, timezone, currency, country, slug)
  └─ PERSON (event-scoped contributor; phone?, user_id? ← the hinge)  ← the ~500
        └─ PLEDGE (commitment: CASH|ITEM|SERVICE; target budget item?)
              └─ FULFILLMENT (payment|delivery; method; verification_status)
INVITATION (token, event, role, state, expiry, uses)  ← precedes EVENT_MEMBER
BILLING_ACCOUNT ─ PLAN ─ ENTITLEMENT_GRANT (scope = event | account)
AUDIT_EVENT · OUTBOX · USAGE_EVENT · PENDING_CONFIRMATION
```

Consequences that are load-bearing:

- **500 contributors ≠ 500 users.** Contributors are `person` rows with `user_id = NULL`.
  They cost nothing, hold no seat, need no account.
- **Claiming links, never duplicates.** A partial-unique index `(event_id, user_id)`
  (Postgres treats NULLs as distinct) means many unclaimed persons per event, but at most
  one person per user per event. A claim sets `person.user_id`; it can never fork a person.
- **A user can be both team and contributor** in the same event (e.g. a co-owner who also
  pledges). Different rows; no special-casing.
- **Seats count `event_member` rows (status = ACTIVE), never `person` rows.**

## 1. Two experiences, one identity/event model

| | Team experience | Contributor experience (post-V1; foundation now) |
|---|---|---|
| Principal | `User` + `EventMember(role)` | `User` linked to `Person`, or a signed per-action SMS token |
| Surface | full AI workspace | lightweight web / SMS: view own status, confirm own pledge, report own payment |
| Authz axis | role-in-event: `can(role, action)` | **ownership**: `resource.person_id === actor.person_id` |
| Context | `OperationContext{ actor, event(role) }` | `ContributorContext{ user, person }` |

The permission engine gains a **contributor branch** beside the role branch. RLS stays as
pure event-isolation (`event_id` GUC); person-ownership is enforced in the service layer,
not overloaded into RLS.

## 2. Locked decisions (reversible)

1. **Unknown person on capture** → one-tap create-with-confirm (smooth + duplicate-safe).
2. **Auth** → phone-OTP + refresh token + session revocation. Not full device management.
3. **Subscription** → scope-agnostic (event or account); seats = active `event_member` count.
4. **Verification** → V1 ships `REPORTED`/`UNVERIFIED`; enum reserves `VERIFIED` for the
   SMS-ingestion wedge (never auto-verify without evidence).

## 3. Domain model — corrections vs what was built in Phases 0–2

| Entity | Change |
|---|---|
| `person` | + `user_id` (nullable FK → user; partial-unique per event) |
| `event_member` | + `status` (INVITED/ACTIVE/REMOVED), + `invited_by` |
| `event_role` | + `CO_OWNER` |
| `event` | + `status` (DRAFT/ACTIVE/PAUSED/CLOSED/ARCHIVED), `target_amount`, `event_date`, `timezone`, `country`, `slug` |
| `fulfillment` | + `method` (MTN/AIRTEL/CASH/BANK/OTHER/UNKNOWN), + `verification_status` (REPORTED/UNVERIFIED/VERIFIED) |
| `invitation` (new) | token, event, role, status (PENDING/ACCEPTED/EXPIRED/REVOKED), invited_by, invited_phone?, max_uses, uses, expires_at, accepted_by?, accepted_at? |
| `session` (new) | user, refresh-token hash, device label, created/last-seen, revoked_at — for refresh + revocation |
| permission catalog | split read into `ledger:read_funding` (redacted %) vs `ledger:read_amounts` (money); VIEWER gets funding only (blueprint §12) |

**One contribution spine, no third concept.** `Pledge(type)` + `Fulfillment` already
expresses cash/item/service and financial/non-financial. A walk-up cash gift is a pledge
(committed = amount) immediately fully fulfilled — so "Peter gave 100k cash" auto-creates
the pledge; `outstanding = committed − Σ fulfillments` stays universal.

## 4. Invitation & claim flows

**Invite (team):** member with `member:manage` → `createInvitation(event, role)` → returns
an unguessable token link. Organizer shares it (WhatsApp/SMS/copy — no WhatsApp API
dependency). Invitation is **not** under event-RLS (the invitee is not a member yet); it is
protected by the token. States: PENDING → ACCEPTED | EXPIRED | REVOKED. Single- or
multi-use.

**Accept (team):** open by token (public) → shows event + role → OTP (existing auth) → JWT
→ `acceptInvitation(token)` → find-or-create user by phone, create `event_member`
(status ACTIVE, `invited_by` = inviter), invitation → ACCEPTED. Idempotent: already-member
→ no-op success; accept-twice → second is a no-op.

**Claim (contributor, post-V1 surface; linkage now):** person gets a signed claim link →
OTP on the person's phone → `claimPerson(user, person)` sets `person.user_id` (guarded by
token + phone match + partial-unique). No phone on file → only an organizer-shared link can
bind. This is the seam for the contributor experience.

## 5. Gates, now three

Every mutating/sensitive action passes, in order:
1. **Permission** — `can(role, action)` (team) or ownership (contributor). In code.
2. **Entitlement** — plan/limits/credits (stub-allow until Phase 5). In code.
3. **Event status** — CLOSED/ARCHIVED reject writes except authorized corrections. In code.

## 6. Idempotency & duplicates

- **Record actions carry a client idempotency key** → dedupe window, so a retried
  "John paid 200k" (network drop) never double-books money. Keyed row, unique.
- **Duplicate heuristic** (Phase 2.x): same person + same amount within a short window →
  ask "another payment, or the same one?" — never silently double-record.

## 7. Revised phase order — lean by principle

**Principle (from the founder): lay the foundational identity decision now; do NOT
pre-decide the whole product.** Only *retrofit-painful* things go early. Additive
columns/tables (event fields, fulfillment method, sessions, idempotency) are cheap,
non-destructive migrations — they wait for their phase.

- **Phase 1.5 (new, next): IDENTITY FOUNDATION + core onboarding ONLY.** The
  retrofit-painful set: `person.user_id` linkage (+ claim seam), person/user/member
  distinction made real, `invitation` + accept flow (core onboarding — invite a non-user),
  `event_member.status` + `invited_by`, `CO_OWNER`, and the amount-visibility permission
  (finance privacy is a stated rule). Nothing else.
- **Deferred to their natural phase (additive, decide when we get there):** event realism
  (status/target/timezone + read-only status gate), fulfillment method/verification,
  spontaneous-payment auto-pledge, record idempotency + duplicate detection, sessions/
  refresh/revocation (auth hardening), campaigns + delivery tracking + reminder cost-preview
  + OTP rate-limit (Phase 3), documents + file metadata (Phase 4), real seats on
  `event_member` basis (Phase 5), reporting + budget-gap + allocation (Phase 6).
- **Contributor self-service surface stays UNBUILT.** We lay only its foundation
  (`person.user_id` + claim seam) so it is a pure addition later — not a pre-decided product.
- **Phase 2 (built) → 3 → 4 → 5 → 6** unchanged in order.

## 8. What stays out of V1 (explicitly)

Inbound SMS / MoMo-notification ingestion (the wedge — model for it), WhatsApp, custom
roles, multi-currency, full device management, campaigns-as-marketing, on-continent region.

## 9. Public Event Transparency (Phase 5 — built)

**Two doorways, one ledger.** Uganda's contribution culture is transparent, so alongside the
authenticated AI workspace there is a second, **unauthenticated read-only surface**: the
shareable public event page (`/e/:slug`). Canonical data is unchanged; the public surface is
a **deliberate projection** that never touches the write path.

**Why the current architecture already supports it:** RLS here enforces *cross-event isolation
only* (the `app.current_event_id` GUC) — it carries no role/user check; permission gating lives
in the app layer. So the public path needs **no new DB bypass**: it resolves the slug, opens
`runInEvent(eventId)` exactly like a member read, and the projection's explicit `select`s are
the field-level boundary.

**Security boundary, three independent layers (all tested):**
1. **RLS** → no *cross-event* leak (`runInEvent` scoping).
2. **`PublicViewService` projection** → no *private-field* leak: it is the one place public
   data is shaped, and never emits `person.id`, phone, `fulfillment.note`, audit, AI, or
   billing (Part 10).
3. **Module wiring** → no *write*: `PublicApiModule` imports only `TransparencyModule`; there
   is structurally no path from a public request to a mutation (Part 26).

**Access model:** a public visitor gets **no role and no `EventMember`** — distinct from
contributor `Person`, authenticated `User`, and `EventMember` (Part 24). Link control (Part 20):
`isPublic` master switch = revocation; optional `publicAccessToken` = invite-only + rotation.

**Coverage matrix (transparency spec → implementation):**

| Spec part | Requirement | Where |
|---|---|---|
| 3, 11, 28 | Consistent public projection (target/pledged/received/outstanding/remaining/%) computed in one txn | `PublicViewService.getPublicEventView` |
| 4, 16 | Budget transparency w/ per-item coverage; PUBLIC / PARTIALLY_PUBLIC (`BudgetItem.isPublic`) / HIDDEN | `buildBudget` + `budgetVisibility` |
| 5, 15 | Contributor list: NAMES_AND_AMOUNTS (default) / NAMES_ONLY / AGGREGATE_ONLY / HIDDEN | `buildContributors` + `contributorVisibility` |
| 6, 7 | Pledge/contributor status (PLEDGED / PARTIALLY_PAID / FULLY_PAID) | `contributorStatus` |
| 10, 26 | Deliberate projection, no private fields, no write path | projection `select`s + `PublicApiModule` |
| 12, 13, 14 | High-read / cache-friendly: ETag + `Cache-Control` + `If-None-Match`→304; `publicRevision` | `PublicController.withCache`, `bumpRevision` |
| 17 | Announcements (DRAFT→PUBLISHED; only published are public) | `AnnouncementService`, `EventAnnouncement` |
| 18, 19 | Zero-custody "how to contribute" (organizer's own MTN/Airtel/bank/cash) | `PaymentInstructionService`, `PaymentInstruction` |
| 20 | Revocation (`isPublic=false`→404), invite-only token (→403), rotation | `PublicViewService.resolve`, `PublicSettingsService` |
| 22, 23, 27 | Link-first contributor surface: separate unauth `/public/events/:slug[/summary|budget|contributors|announcements|contribute]` | `PublicController` |
| 24, 26 | Public visitor ≠ member ≠ user ≠ person | `PublicRateLimitGuard` + no member context |
| 13, 20 | Basic abuse protection for the naked endpoint | `PublicRateLimitGuard` (CDN/WAF deferred to ops) |

**Deferred exactly as the spec defers them:** CDN/edge caching + read replicas (the read path
is built cache-friendly so they plug in on top), real-time updates (V1 uses short cache),
analytics (privacy-first), and **contributor identity claiming (Part 8)** — the projection
exposes no `person.id`, so nothing depends on it; the OTP claim flow lands in the identity
slice.
