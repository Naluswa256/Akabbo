# AKABBO — Admin Panel: Users/Plans + Conversation Inbox + Budget Knowledge

This is a **founder-only** surface, not a feature for regular app users. There is no admin *role* in this system yet — it's gated by a **shared secret header**, the same mechanism already used for `/ai/learning/*`. This panel should live in a separate, non-public part of the frontend (not reachable from the normal organizer UI), and the secret should be entered once and stored locally (e.g. a simple password-gate screen), never bundled into the public app.

**Auth:** every request needs `x-akabbo-admin-secret: <the secret>` header. No JWT, no `Authorization` header — deliberately separate from normal user auth. Missing or wrong secret → `403 Forbidden`.

---

## 1. Users + plans

### List every user with their current plan

```
GET /admin/users
x-akabbo-admin-secret: <secret>
```

```json
[
  {
    "id": "987679d7-...",
    "phone": "+256701234567",
    "phoneVerified": true,
    "email": null,
    "emailVerified": false,
    "displayName": null,
    "createdAt": "2026-07-20T09:00:00.000Z",
    "planCode": "STARTER",
    "planStatus": "ACTIVE",
    "aiBalance": 478,
    "smsBalance": 300,
    "ownedEventCount": 2
  }
]
```

- **New:** `email`/`emailVerified`, alongside `phone`/`phoneVerified` — accounts can now sign up via phone OTP or email OTP (see FRONTEND_PAYLOAD_EXAMPLES.md §1). Exactly one identity pair is ever populated per user today (`phone` set + `email: null`, or the reverse) — there's no account linking, so never assume both are present. Render whichever is non-null as the user's identifier.
- `planStatus` is one of `TRIALING | ACTIVE | PAST_DUE | EXPIRED | CANCELLED`. **`TRIALING` = free trial, never paid. `ACTIVE` = currently paying.** That distinction is exactly "who's on free trial vs who's on a paid plan."
- `planCode` is `FREE` for anyone with no billing account or no grant yet (most brand-new signups before they've done anything).
- `aiBalance`/`smsBalance` reflect the user's canonical account-level balance (their oldest billing account, pooled with any event-scoped credits per event — same resolution logic used everywhere else in the app, not a simplified view).
- Capped at 200 most-recently-created users. No pagination yet — ask if you need it once the user count grows past that.
- **Read-only, no side effects.** Viewing this list never creates a billing account for a user who doesn't have one yet (unlike some internal flows) — a user with no account shows `FREE`/`TRIALING`(default)/`0`/`0` cleanly.

### Aggregate counts (dashboard tiles)

```
GET /admin/users/summary
x-akabbo-admin-secret: <secret>
```

```json
{
  "totalUsers": 47,
  "onFreeTrial": 39,
  "onPaidPlan": 8,
  "byPlan": { "FREE": 35, "STARTER": 6, "STANDARD": 2, "BUSINESS": 4 }
}
```

Note `byPlan` counts are by **plan code**, and `onFreeTrial`/`onPaidPlan` are by **status** — a user can be `STARTER` + `TRIALING` if they're mid-trial on a paid-tier plan, so these two breakdowns aren't strictly the same partition. Use `byPlan` for "how many on each plan" and `onFreeTrial`/`onPaidPlan` for the trial-vs-paying headline number.

This endpoint currently just scans up to 1000 users and aggregates in memory — fine for now, not built for a huge user base.

---

## 2. Conversation inbox — read what users asked and how the AI answered

### List conversations across every user

```
GET /admin/conversations?limit=50&offset=0
x-akabbo-admin-secret: <secret>
```

```json
[
  {
    "id": "c1a2b3d4-...",
    "userId": "987679d7-...",
    "userPhone": "+256701234567",
    "title": null,
    "activeEventId": "210d2484-2ce7-4160-bfe7-7895af763ce2",
    "messageCount": 14,
    "createdAt": "2026-07-24T10:00:00.000Z",
    "updatedAt": "2026-07-25T13:32:00.710Z"
  }
]
```

- Most recently active first (real activity — bumped on every message, same fix as the regular resume-chat feature).
- `userPhone` is how you identify *whose* conversation this is — cross-reference `userId` against `GET /admin/users` if you want their plan/status alongside it in the UI.
- `title` is always `null` today (no auto-titling anywhere in the system yet) — show `activeEventId` (resolve the event name via `GET /events/:id` if you want it) or the message count/last-updated as your list-row label instead.
- `limit`/`offset` for simple pagination — default `limit=50, offset=0` if omitted.

### Read a specific conversation's full transcript

```
GET /admin/conversations/:id/messages
x-akabbo-admin-secret: <secret>
```

```json
[
  { "id": "m1...", "role": "user", "content": "namayanja prossy 0701578058 has pledged for 30k", "createdAt": "2026-07-25T10:00:00.000Z" },
  { "id": "m2...", "role": "assistant", "content": "I have staged the following pledge...", "createdAt": "2026-07-25T10:00:02.000Z" }
]
```

Same shape as the user-facing message history — `role: "user" | "assistant"`, oldest first, ready to render as a transcript. **No ownership check** (that's the entire point of this endpoint — any conversation, any user), so treat this as sensitive: it's real message content from real organizers, including names/amounts/phone numbers they've typed. Don't log or cache this client-side beyond the session.

### Recommended flow

```
1. GET /admin/users/summary        → dashboard tiles (trial vs paid, per-plan breakdown)
2. GET /admin/users                → full user table, sortable/filterable client-side
3. GET /admin/conversations         → inbox list, most recent first
4. Click a row → GET /admin/conversations/:id/messages → transcript view
```

---

## 3. Budget knowledge — pre-budgeting source review + admin uploads

Context: the AI can now answer "what should I budget for a kwanjula" *before* an event exists (`get_budget_recommendation`, usable in chat with no active event selected) by drawing on a shared, global knowledge base populated three ways — a small curated seed, demand-driven live web search, and admin-vetted uploads. This section is the admin side of that: uploading a real budget you've personally sourced, and reviewing what's already in the knowledge base. Same auth as everything else on this page (`x-akabbo-admin-secret`).

**Why admin uploads matter more than the other sources:** they're the highest-trust input. When a category has at least one admin-uploaded observation, the recommendation is built from *only* that — a generic blog range or an unreviewed live-search snippet never gets to outvote a real, vetted document for the same category. Use `note` on upload to record how it was sourced (who shared it, on what basis) — that becomes part of the source's `licensingNote`, which is the honesty/provenance record for this entire feature (never Scribd or similar — their own terms prohibit it; always something an admin can actually attribute).

### Upload a real budget document

```
POST /admin/budget-knowledge/uploads
x-akabbo-admin-secret: <secret>
Content-Type: application/json

{
  "filename": "sarahs-kwanjula-budget.xlsx",
  "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "dataBase64": "<base64 file bytes>",
  "eventTypeHint": "kwanjula",
  "regionHint": "Mbale",
  "note": "Shared directly by the family via WhatsApp, with permission to use anonymized"
}
```

```json
{ "sourceId": "b7e1...", "eventType": "kwanjula", "observationCount": 9 }
```

- **This call is synchronous** — unlike the per-event document upload (async, worker-processed), this does the Gemini extraction inline and returns once it's done. Expect several seconds, not milliseconds; show a real loading state, not a fire-and-forget submit.
- **Supported `mimeType`s**: `.docx` → `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `.xlsx` → `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `.csv` → `text/csv`, `.txt` → `text/plain`, plus `image/png`, `image/jpeg`, `image/webp`, and `application/pdf` for photographed/scanned budgets. Anything else → `400 Bad Request`.
- **`eventTypeHint` is strongly recommended, not really optional**: without it, if the model can't confidently infer an event type from the document itself, the request 400s ("Could not determine an event type for this document"). Always collect it from the admin before upload rather than leaving it blank and hoping.
- **`observationCount: 0` is a valid, non-error response** — the upload succeeded but nothing extractable was found (e.g. the document didn't actually contain concrete figures). Surface this plainly ("uploaded, but nothing usable was extracted") — don't treat every 200 as "rich data landed."
- The original file is preserved in storage (never discarded after extraction) but there's no download/preview endpoint for it yet — ask if the panel needs "view the original" and we'll add a signed-URL endpoint the same way per-event documents already have one.

### Browse what's in the knowledge base

```
GET /admin/budget-knowledge/sources?sourceType=admin_upload&eventType=kwanjula&limit=50
x-akabbo-admin-secret: <secret>
```

```json
[
  {
    "id": "b7e1...",
    "sourceType": "admin_upload",
    "name": "admin-upload:sarahs-kwanjula-budget.xlsx",
    "url": null,
    "reliability": "HIGH",
    "extractionMethod": "ai_extraction_reviewed",
    "originalFilename": "sarahs-kwanjula-budget.xlsx",
    "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "collectedAt": "2026-08-01T12:00:00.000Z",
    "observationCount": 9
  }
]
```

All query params optional — omit `sourceType` to see everything in one list (curated seed, live search, organizer per-event uploads, admin uploads), omit `eventType` for all event types. `limit` defaults 50, capped 200. Newest first.

`sourceType` values: `manual_entry` (hand-curated, no source document) | `public_article` (a blog — curated or live-search-found; check `extractionMethod` to tell which) | `user_upload` (an organizer's own per-event budget, auto-flows in, unreviewed) | `admin_upload` (this feature) | `akabbo_aggregate` (reserved for a future aggregate-Akabbo-data source, not populated yet).

### Review one source's extracted observations

```
GET /admin/budget-knowledge/sources/:id
x-akabbo-admin-secret: <secret>
```

Returns the source (same fields as one row above) plus an `observations` array — each row's `category`, `item`, `region`, `tier`, `amountMin`/`amountMax` (plain digit strings, minor units, same money convention as everywhere else in this app — `null` on a pattern-only row like "commonly forgotten"), `unit`, `commonlyForgotten`, `confidence` (0–1 float), `observedAt`. This is the "did the extraction actually get it right" view — use it to decide whether an upload needs correcting or redoing. 404s with a clear message if the id doesn't exist.

### Recommended flow

```
1. GET /admin/budget-knowledge/sources            → browse what's already there
2. Admin has a new real budget to add              → collect file + eventTypeHint (+ regionHint, note)
3. POST /admin/budget-knowledge/uploads             → wait for the (synchronous) response
4. GET /admin/budget-knowledge/sources/:id          → show what was extracted, let the admin sanity-check it
```

### What this section does NOT do (yet)

- **No edit/delete/re-run** — if an upload extracted something wrong, there's no correction endpoint yet; ask and we'll add one (most likely delete-and-reupload rather than in-place editing, to keep provenance honest).
- **No download/preview of the original file** — bytes are preserved in storage, just not exposed via a signed URL yet.
- **No confirmation/review gate before an admin upload counts.** Unlike every AI-initiated write in the main app (staged to `pending_confirmation` first), an admin upload is trusted the moment it's submitted — deliberate: an admin choosing to upload a real document *is* the review, the same way a curator picking a source is. There's no second human in the loop to gate it further.

---

## 4. What Users/Plans + Conversation Inbox do NOT do

- **No write actions** — this is read-only reporting. Changing a user's plan, banning someone, editing a conversation — none of that exists here.
- **No search/filter server-side** on users or conversations (by phone, by plan, by date range) — filter/sort client-side on the returned list for now.
- **No pagination on `/admin/users`** (flat 200-row cap) — fine short-term.
- **This is the same secret as `/ai/learning/*` and the budget-knowledge endpoints above** — one screen/auth gate covers all of it, no separate logins needed.
