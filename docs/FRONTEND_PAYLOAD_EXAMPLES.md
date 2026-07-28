# AKABBO — FRONTEND PAYLOAD EXAMPLES

Companion to **FRONTEND_AI_INTERACTION_CONTRACT.md**. Every request/response below is the **real shape** produced by the code (verified 2026-07-23), with example values filled in. Field names, nullability, and enums are exact; the *values* are illustrative.

**Conventions**
- All money is an **integer-minor-units STRING** (UGX has no decimals, so `"25000000"` = UGX 25,000,000). Format for display; never do maths on it as a JS number.
- All dates are **ISO-8601 strings** or `null`.
- Authenticated calls need `Authorization: Bearer <accessToken>`.
- IDs shown as `evt_…`, `pc_…` etc. are illustrative; the API returns real UUIDs (and opaque base64url tokens for invitations/public access).

---

## 1. ONBOARDING (phone OTP → session)

Two steps. No passwords. A verified phone is required before the assistant will act.

### 1.1 Start OTP
```http
POST /auth/otp/start
Content-Type: application/json

{ "phone": "+256701234567" }
```
**200**
```json
{
  "challengeId": "c3f1e0a2-8b7d-4a11-9c2e-1f6b8a0d4e55",
  "expiresInSeconds": 300,
  "devCode": "123456"
}
```
- `devCode` is present **only in dev/staging** (so you can auto-fill during testing). In production it is absent — the code arrives by SMS. Never render it if missing.
- Store `challengeId`; you need it for verify.

### 1.2 Verify OTP
```http
POST /auth/otp/verify
Content-Type: application/json

{ "challengeId": "c3f1e0a2-…", "code": "123456" }
```
**200**
```json
{
  "userId": "usr_7a2b…",
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "expiresAt": "2026-07-30T09:00:00.000Z"
}
```
- Persist `accessToken` + `expiresAt`; send the token on every authenticated request.
- **Do not** tie usage limits or "free trial remaining" to a fresh token — limits key off `userId`/`eventId` server-side; re-logging in resets nothing (by design).

**Failure examples**
- Wrong/expired code → `401 Unauthorized` (`{ "statusCode": 401, "message": "…" }`). Let the user retry or resend.
- After verify, first action on the assistant with an unverified phone would be refused — but a successful verify sets `phoneVerified`, so this won't happen in the normal flow.

---

## 2. INVITING A COMMITTEE MEMBER

Two ways to create an invitation: **directly via REST**, or **conversationally via the AI** (which stages it for confirmation). Both end in the same share-link → OTP → accept flow. An invitation **precedes membership** — you can invite someone with no account yet. The unguessable `token` is the capability; a leaked link is inert until the invitee does OTP and accepts.

**Roles** (`EventRole`): `OWNER` (never invitable), `CO_OWNER`, `COORDINATOR`, `FINANCE`, `VIEWER`. **Never show raw enum names to end users** — use the plain-language labels the AI uses (below).

### 2.1a Create invitation — direct REST
```http
POST /events/evt_123/invitations
Authorization: Bearer …
Content-Type: application/json

{ "role": "COORDINATOR", "invitedPhone": "+256772000111", "maxUses": 1, "ttlSeconds": 604800 }
```
**200** (`InvitationView`)
```json
{
  "id": "inv_9f1c…",
  "token": "Rk9vQmFyQmF6MTIzNDU2Nzg5MGFiY2RlZg",
  "role": "COORDINATOR",
  "status": "PENDING",
  "expiresAt": "2026-07-30T09:00:00.000Z"
}
```
- `maxUses` defaults to `1`; `ttlSeconds` defaults to 7 days.
- **Build the share link yourself:** `https://<app>/join/<token>` (see §2.3). The REST create returns only the raw `token`.
- **Seat limit:** if the plan's team seats are full, this returns **`403 Forbidden`** with a message like *"Team seat limit reached"*. Turn that into an Upgrade CTA, not an error toast.

### 2.1b Create invitation — via the AI (staged)
```http
POST /assistant
{ "message": "Invite Joash to the committee", "conversationId": "conv_1" }
```
If the user didn't say what Joash can do, the AI **asks in plain language** (it never guesses the role):
```json
{
  "conversationId": "conv_1",
  "activeEventId": "evt_123",
  "reply": "What should Joash be able to do? Reply with one:\n• Help run the event — add people, record payments, and send reminders\n• Handle the money — record and correct payments only\n• Co-organize — full control, including inviting others\n• Just view progress — see the event but not change anything",
  "staged": []
}
```
Render those four as tappable choices. The user's answer (e.g. "help run the event") comes back on the next turn, and the AI **stages** the invite:
```json
{
  "conversationId": "conv_1",
  "activeEventId": "evt_123",
  "reply": "Invite Joash so they can help run the event — add people, record payments, and send reminders? I'll create a join link they open to enter their phone and verify a code.",
  "staged": ["pc_inv_1"]
}
```
Then confirm it (§ Confirmation flow in the main contract):
```http
POST /events/evt_123/pending/pc_inv_1/confirm
```
**200** (`ExecutionResult`) — the join link comes back **after confirming**:
```json
{
  "message": "Invitation created for Joash as COORDINATOR. Share this link — they join by entering their phone and verifying an OTP:\nhttps://app.akabbo.com/join/Rk9vQmFyQmF6MTIzNDU2Nzg5MGFiY2RlZg",
  "data": {
    "token": "Rk9vQmFyQmF6MTIzNDU2Nzg5MGFiY2RlZg",
    "role": "COORDINATOR",
    "invitePath": "/join/Rk9vQmFyQmF6…",
    "inviteUrl": "https://app.akabbo.com/join/Rk9vQmFyQmF6…",
    "expiresAt": "2026-07-30T09:00:00.000Z",
    "displayName": "Joash"
  }
}
```
- `inviteUrl` is non-null **only when `PUBLIC_APP_URL` is configured** on the backend. **Today it is not set on the live service, so `inviteUrl` will be `null` and you must build the URL from `invitePath`.** Render a copy-link card from `inviteUrl ?? (origin + invitePath)`.

### 2.2 Invitee opens the link — public landing (no auth)
```http
GET /invitations/Rk9vQmFyQmF6…
```
**200** (`PublicInvitationView`) — leaks only event name + role:
```json
{ "eventName": "William & Sarah Wedding", "role": "COORDINATOR", "status": "PENDING", "valid": true }
```
- If `valid` is `false` (expired/revoked/used), show a "this invite is no longer active" state and stop.
- Map `role` to a plain-language "you'll be able to …" line; don't show `COORDINATOR`.
- **404** if the token doesn't exist.

### 2.3 Invitee authenticates, then accepts
The invitee does the **same OTP flow as §1** (they may be a brand-new user). Then, with their token:
```http
POST /invitations/Rk9vQmFyQmF6…/accept
Authorization: Bearer <invitee accessToken>
```
**200**
```json
{ "eventId": "evt_123", "role": "COORDINATOR", "alreadyMember": false }
```
- Idempotent: an existing member returns `{ …, "alreadyMember": true }` without consuming a use.
- Expired/revoked → `403 Forbidden`. On success, route them into the event workspace for `eventId`.

### 2.4 Manage invitations
```http
GET  /events/evt_123/invitations            → InvitationView[]
POST /events/evt_123/invitations/inv_9f1c/revoke   → { "ok": true }
```

**Full onboarding sequence to build:**
`organizer: "invite Joash to committee"` → AI asks role (plain language) → confirm → **share-link card** → organizer shares → invitee opens `GET /invitations/:token` → invitee OTP (§1) → `POST /invitations/:token/accept` → member lands in the event.

---

## 3. PUBLIC VIEWS (unauthenticated transparency)

> **⚠️ Changed 2026-07-28 — 3 breaking-ish changes to `PublicEventView`, none require a migration but ALL require a code change on your side:**
> 1. **`target`, `totalOutstanding`, `remaining`, `percentCovered` are now nullable.** They used to be unconditionally present whenever the event was public; they can now be `null` when the organizer has hidden them (new `showTarget`/`showOutstanding` settings, §3.4). **Any code that assumes these are always a string/number will break** — add null checks.
> 2. **Each contributor now carries `pledges[]`** — the individual pledge(s) + payment entries behind their `committed`/`received` totals (§3.1 example below). This is additive — existing fields (`displayName`, `committed`, `received`, `outstanding`, `status`) are unchanged.
> 3. **`visibility` gained two fields**: `showTarget`, `showOutstanding` (booleans), alongside the existing `contributors`/`budget`.
>
> Nothing about `contributorVisibility`/`budgetVisibility` semantics changed — this is a new, independent pair of toggles layered on top.

The contributor-facing site. **No auth, no account, no AI.** Everything resolves a public **slug** (+ optional `?t=` token for invite-only events). This is a deliberate projection — it can never expose person ids, phones, notes, audit rows, AI history, or internals.

### 3.1 Full event view
```http
GET /public/events/william-sarah-wedding-1a2b3c4d
```
(For invite-only events add `?t=<publicAccessToken>` or header `x-akabbo-access-token`.)

**200** (`PublicEventView`) — fully-populated example (`contributorVisibility: NAMES_AND_AMOUNTS`, `budgetVisibility: PUBLIC`):
```json
{
  "slug": "william-sarah-wedding-1a2b3c4d",
  "name": "William & Sarah Wedding",
  "description": "Help us celebrate on 12 December.",
  "eventDate": "2026-12-12T00:00:00.000Z",
  "status": "ACTIVE",
  "currency": "UGX",

  "target": "25000000",
  "totalPledged": "18000000",
  "totalReceived": "14500000",
  "totalOutstanding": "3500000",
  "remaining": "10500000",
  "percentCovered": 58,

  "contributorCount": 42,
  "budget": {
    "total": "20000000",
    "covered": "12000000",
    "remaining": "8000000",
    "items": [
      { "name": "Catering",     "target": "5000000", "covered": "5000000", "remaining": "0",       "status": "FUNDED" },
      { "name": "Venue",        "target": "8000000", "covered": "6000000", "remaining": "2000000", "status": "PARTIALLY_FUNDED" },
      { "name": "Photography",  "target": "2000000", "covered": "0",       "remaining": "2000000", "status": "UNFUNDED" }
    ]
  },
  "contributors": [
    {
      "displayName": "John Kato", "committed": "5000000", "received": "5000000", "outstanding": "0", "status": "FULLY_PAID",
      "pledges": [
        {
          "type": "CASH", "committedValue": "5000000", "description": null, "status": "FULLY_PAID", "outstanding": "0",
          "payments": [
            { "value": "3000000", "kind": "PAYMENT", "occurredAt": "2026-07-10T09:00:00.000Z" },
            { "value": "2000000", "kind": "PAYMENT", "occurredAt": "2026-07-18T11:30:00.000Z" }
          ]
        }
      ]
    },
    {
      "displayName": "Annet Nakato", "committed": "2000000", "received": "1000000", "outstanding": "1000000", "status": "PARTIALLY_PAID",
      "pledges": [
        {
          "type": "CASH", "committedValue": "2000000", "description": null, "status": "PARTIALLY_PAID", "outstanding": "1000000",
          "payments": [ { "value": "1000000", "kind": "PAYMENT", "occurredAt": "2026-07-20T14:03:00.000Z" } ]
        }
      ]
    },
    {
      "displayName": "Peter Ssali", "committed": "1000000", "received": "0", "outstanding": "1000000", "status": "PLEDGED",
      "pledges": [
        { "type": "CASH", "committedValue": "1000000", "description": null, "status": "PLEDGED", "outstanding": "1000000", "payments": [] }
      ]
    }
  ],
  "recentActivity": [
    { "displayName": "John Kato", "value": "2000000", "occurredAt": "2026-07-20T14:03:00.000Z" }
  ],
  "announcements": [
    { "body": "We've reached 58% of our target — thank you!", "publishedAt": "2026-07-21T08:00:00.000Z" }
  ],
  "paymentInstructions": [
    { "method": "MTN",   "label": "MTN MoMo", "details": "0771 234 567 (William)" },
    { "method": "AIRTEL","label": "Airtel Money", "details": "0701 234 567 (Sarah)" }
  ],
  "revision": 37,
  "visibility": { "contributors": "NAMES_AND_AMOUNTS", "budget": "PUBLIC", "showTarget": true, "showOutstanding": true }
}
```

**Per-contributor pledge/payment breakdown (new):** each contributor at `NAMES_AND_AMOUNTS` now carries `pledges[]` — one entry per pledge they have (usually one, but a person can pledge more than once), each with its own `payments[]` — the individual splits recorded against it. This is the "pledge 1M, then below it, the entries of payments made against it" view. `payments[].kind` is `PAYMENT` (cash) or `DELIVERY` (an in-kind split); `pledges[].description` is set only for `ITEM`/`SERVICE` pledges.

**Visibility gating — sections become `null`, and `visibility` tells you why.** Handle every case:

| `visibility.contributors` | `contributorCount` | `contributors` | `recentActivity` |
|---|---|---|---|
| `NAMES_AND_AMOUNTS` | number | full objects (amounts + `status` + `pledges[]`) | up to 10 recent |
| `NAMES_ONLY` | number | `[{ displayName }]` only (no amounts, no pledges) | `null` |
| `AGGREGATE_ONLY` | number | `null` | `null` |
| `HIDDEN` | `null` | `null` | `null` |

| `visibility.budget` | `budget` |
|---|---|
| `PUBLIC` | full breakdown, all items |
| `PARTIALLY_PUBLIC` | breakdown, but only items the organizer flagged public |
| `HIDDEN` | `null` |

**`showTarget`/`showOutstanding` (new) — independent of the two tables above.** Some organizers don't want contributors to see how far behind the event is, even while showing what's been raised:

| Flag | `false` → these become `null`/omitted |
|---|---|
| `showTarget` | top-level `target`, `remaining`, `percentCovered` |
| `showOutstanding` | top-level `totalOutstanding`; every contributor's `outstanding`; every `pledges[].outstanding` |

`totalPledged`/`totalReceived` and every `committed`/`received`/`payments[]` value are **never** gated by these two flags — only outstanding/target figures are. `totalPledged`, `totalReceived` are always present strings when the event is public; `target`, `totalOutstanding`, `remaining`, `percentCovered` are all `string | number | null` — always check for `null` rather than assuming presence (previously these five were unconditionally present; that's no longer true).

`PaymentMethod` enum: `MTN | AIRTEL | CASH | BANK | OTHER | UNKNOWN`. `FulfillmentKind` (payment entry `kind`): `PAYMENT | DELIVERY`.

### 3.2 Lighter slices (same auth rules, cheaper)
```http
GET /public/events/:slug/summary        → headline totals + name/date/status/revision
GET /public/events/:slug/budget         → { budget, visibility: <BudgetVisibility> }
GET /public/events/:slug/contributors   → { contributors, contributorCount, visibility: <ContributorVisibility> }
GET /public/events/:slug/announcements   → { announcements: PublicAnnouncement[] }
GET /public/events/:slug/contribute      → { paymentInstructions: PublicPaymentInstruction[] }
```
`/summary` example:
```json
{
  "slug": "william-sarah-wedding-1a2b3c4d", "name": "William & Sarah Wedding",
  "description": "Help us celebrate on 12 December.", "eventDate": "2026-12-12T00:00:00.000Z",
  "status": "ACTIVE", "currency": "UGX",
  "target": "25000000", "totalPledged": "18000000", "totalReceived": "14500000",
  "totalOutstanding": "3500000", "remaining": "10500000", "percentCovered": 58,
  "contributorCount": 42, "revision": 37
}
```

### 3.3 Caching & errors
- Every public route sends `ETag` + `Cache-Control: public, max-age=30, stale-while-revalidate=60`. Send `If-None-Match: <etag>`; a match returns **304** with no body. Use `revision` as a cheap change signal for polling.
- **404** for a missing OR non-public (revoked) event — deliberately indistinguishable (no existence oracle).
- **Invite-only without/with-wrong token** → a token-required error. Prompt for the link's `?t=` value.

### 3.4 Organizer control plane (authenticated) — what drives the public page
```http
GET   /events/:id/public/settings
PATCH /events/:id/public/settings      { isPublic?, contributorVisibility?, budgetVisibility?, showTarget?, showOutstanding?, description? }
POST  /events/:id/public/token/rotate   ← makes it invite-only / rotates the token
DELETE /events/:id/public/token         ← makes it openly public (no token)

GET  /events/:id/announcements
POST /events/:id/announcements          { body }              ← creates a DRAFT
POST /events/:id/announcements/:id/publish                    ← makes it public
POST /events/:id/announcements/:id/archive

GET/POST/PATCH/DELETE /events/:id/payment-instructions
```
The AI can also **draft** and **publish** announcements (draft executes immediately; publish is staged — see main contract §5).

**`showTarget`/`showOutstanding` (new)** — this is where the "hide budget target / amount outstanding from contributors" toggle for the public-link creation/settings screen lives. Both default `true` (existing behavior — nothing changes unless the organizer explicitly turns one off). Example:

```http
GET /events/evt_123/public/settings
```
```json
{
  "slug": "william-sarah-wedding-1a2b3c4d",
  "isPublic": true,
  "accessToken": null,
  "contributorVisibility": "NAMES_AND_AMOUNTS",
  "budgetVisibility": "PUBLIC",
  "showTarget": true,
  "showOutstanding": true,
  "description": "Help us celebrate on 12 December.",
  "revision": 37
}
```

To hide just the target/outstanding figures (contributors still see names + what's been received, just not the target or how far short anyone/the event is):
```http
PATCH /events/evt_123/public/settings
Content-Type: application/json

{ "showTarget": false, "showOutstanding": false }
```
Send only the field(s) changing — this is a partial update, same as `contributorVisibility`/`budgetVisibility` already work. The response is the full updated `PublicSettingsView` (same shape as the GET above), and `revision` bumps — the public page's `visibility.showTarget`/`visibility.showOutstanding` (§3.1) will reflect it on next fetch.

---

## 4. BUDGET

**Moved to its own doc:** [FRONTEND_BUDGET_PANEL.md](FRONTEND_BUDGET_PANEL.md) — the full budget spreadsheet-viewer panel: listing items with per-item coverage, adding/editing lines (direct REST + via AI chat), and marking a line "covered" (always allocation-backed, never a settable flag — both the manual 2-call flow and the AI `allocate_to_budget` chat capability are covered there).

---

## 5. DOCUMENT / BUDGET EXTRACTION

**What exists today:** upload a file → submit it for **async** extraction on the worker → the model reads it → each detected **budget line becomes a pending confirmation** the organizer approves. It is a **REST flow, not a chat capability** — you cannot drop a file into the assistant and have it ingest it.

> **Scope limit:** extraction is wired for **BUDGET documents only.** `ExtractionKind` also has `CONTRIBUTION_LIST` and `UNKNOWN`, but the extractor currently only produces budget line items. Do **not** build a "photograph your contribution list → auto-import contributors" flow yet — it isn't implemented. Photos/PDFs/DOCX/XLSX of **budgets** work.

### 5.1 Upload the file
```http
POST /events/evt_123/files
Content-Type: application/json

{
  "kind": "DOCUMENT_PHOTO",
  "mimeType": "image/jpeg",
  "dataBase64": "<base64 of the image>",
  "filename": "budget.jpg"
}
```
**200** (`FileView`)
```json
{
  "id": "file_5c…",
  "kind": "DOCUMENT_PHOTO",
  "mimeType": "image/jpeg",
  "sizeBytes": 482113,
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "originalFilename": "budget.jpg"
}
```
- `FileKind`: `PROFILE_PHOTO | DOCUMENT | DOCUMENT_PHOTO | PAYMENT_EVIDENCE | CONTRIBUTION_EVIDENCE | EVENT_PHOTO`.
- Only images/PDFs are extractable; unsupported types → `400`.
- Retrieve later via `GET /events/:id/files/:fileId/url` → `{ "url": "<short-lived signed URL>" }`.

### 5.2 Submit for extraction (async — returns immediately)
```http
POST /events/evt_123/documents
{ "fileId": "file_5c…", "kind": "BUDGET" }
```
**200** (`DocumentView`)
```json
{ "id": "doc_9", "fileId": "file_5c…", "kind": "BUDGET", "status": "UPLOADED", "error": null }
```
- Work runs on the worker; this call does **not** block on the model.

### 5.3 Poll status
```http
GET /events/evt_123/documents/doc_9      → DocumentView
```
Status transitions:
```
UPLOADED → PROCESSING → REQUIRES_REVIEW      (success: proposals await confirmation)
                     ↘  FAILED               (error is in the `error` field)
```
`REQUIRES_REVIEW` example:
```json
{ "id": "doc_9", "fileId": "file_5c…", "kind": "BUDGET", "status": "REQUIRES_REVIEW", "error": null }
```
- `DocumentStatus`: `UPLOADED | PROCESSING | PROCESSED | FAILED | REQUIRES_REVIEW | APPROVED`.
- Poll every ~2–3s while `PROCESSING`. Show a "Reading budget…" state.

### 5.4 Review & approve the extracted lines
On `REQUIRES_REVIEW`, the detected lines are waiting in the shared **pending** queue as `create_budget_item` proposals (provenance `ai_from_document`, linked to the document):
```http
GET /events/evt_123/pending      → PendingView[]
```
```json
[
  { "id": "pc_ext_1", "intent": "create_budget_item", "prompt": "I read a budget line “Catering” of 5000000 — add it?",    "confidence": 0.82, "status": "PENDING" },
  { "id": "pc_ext_2", "intent": "create_budget_item", "prompt": "I read a budget line “Venue” of 8000000 — add it?",       "confidence": 0.82, "status": "PENDING" },
  { "id": "pc_ext_3", "intent": "create_budget_item", "prompt": "I read a budget line “Photography” of 2000000 — add it?", "confidence": 0.82, "status": "PENDING" }
]
```
Render an **extraction review screen**: one row per proposal with **Confirm / Reject**, plus a bulk "Add all." Each confirm/reject hits:
```http
POST /events/evt_123/pending/pc_ext_1/confirm    → ExecutionResult { message, data: BudgetItemView }
POST /events/evt_123/pending/pc_ext_2/reject     → { id, status: "REJECTED" }
```
- `confidence` (0–1) lets you flag low-confidence rows for extra scrutiny.
- Nothing is written to the budget until a human confirms — this is the safety gate for OCR/extraction uncertainty. After confirming, re-fetch `GET /events/:id/budget`.

**Full extraction sequence:**
`POST /files` → `POST /documents` → poll `GET /documents/:id` until `REQUIRES_REVIEW` → `GET /pending` → confirm/reject each → refresh budget.

---

## 6. Quick reference — where each thing comes from

| You want | Call |
|---|---|
| Log in | `POST /auth/otp/start` → `POST /auth/otp/verify` |
| Invite a member (conversational) | `POST /assistant` → confirm the staged `invite_member` |
| Invite a member (form) | `POST /events/:id/invitations` |
| Invite landing page | `GET /invitations/:token` (public) |
| Accept invite | `POST /invitations/:token/accept` |
| Public event page | `GET /public/events/:slug[?t=]` (+ slices) |
| Configure what's public | `PATCH /events/:id/public/settings`, announcements, payment-instructions |
| Read budget lines | `GET /events/:id/budget` |
| Budget coverage/funding status | `GET /events/:id/report` (or AI `get_budget`) |
| Import a budget doc/photo | `POST /files` → `POST /documents` → poll → `GET /pending` → confirm |
| Confirm/reject any staged write | `GET/POST /events/:id/pending[/:id/confirm|reject]` |
