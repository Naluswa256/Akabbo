# AKABBO — FRONTEND AI INTERACTION CONTRACT

**Audience:** the agent building the Akabbo AI-first frontend.
**Authority:** this document describes the **actual backend as implemented today** (verified against source on 2026-07-23). Where the ideal design and the code differ, the code wins and the gap is called out explicitly.

> **The single most important thing to internalise first**
>
> The AI endpoints return **natural-language text plus a little metadata** — they do **NOT** return a typed state machine (`PERSON_SELECTION_REQUIRED`, `EVENT_SELECTION_REQUIRED`, `CONFIRMATION_REQUIRED`, …). Those states exist *inside* the agent loop as tool results, but they are **collapsed into the assistant's prose `reply`** before they reach you.
>
> So the frontend gets structured signal from exactly **three** places today:
> 1. `activeEventId` — which event the conversation is now on (or `null`).
> 2. `staged: string[]` — IDs of writes parked for confirmation this turn (non-empty ⇒ show confirmation UI).
> 3. The **direct REST read endpoints** (`/events/:id/report`, `/budget`, `/people`, `/pending`, …) — call these to render tables/cards with authoritative numbers instead of scraping the AI's text.
>
> Everything else (disambiguation prompts, "which event?", clarifications) currently arrives as **text in `reply`**. Rendering those as rich cards requires the frontend to either (a) show them conversationally, or (b) drive cards from the REST reads. See **§8 Known limitations**.

---

## 1. Architecture in one picture

```
                    ┌──────────────────────── AUTHENTICATED (JWT) ───────────────────────┐
 USER (organizer) → │  POST /assistant            ← primary AI surface (resolves event)   │
                    │  POST /events/:id/assistant ← AI surface with event fixed           │
                    │  GET/POST direct REST        ← rich data + confirmations            │
                    └────────────────────────────────────────────────────────────────────┘
                                              │
                              agent loop (read tools + staged write tools)
                                              │
                                    Postgres (source of truth, RLS by event)
                                              │
                    ┌──────────────────── UNAUTHENTICATED (link only) ───────────────────┐
 CONTRIBUTOR      → │  GET /public/events/:slug[?t=token]  ← read-only transparency page   │
                    └────────────────────────────────────────────────────────────────────┘
```

- **Two AI surfaces, same brain.** Both run the same agentic loop over the same tools. The only difference is event scope (see §3).
- **The AI never invents numbers.** Every figure is computed in SQL by a read tool; the model only phrases it. You can trust — and independently fetch — the same numbers from REST.
- **Writes are staged, not applied.** The AI *proposes*; a human confirms via `/pending`. (Exceptions: group create/assign, and announcement *draft*, execute immediately — see §5.)
- **No streaming.** Every AI turn is a single request → single JSON response (the whole tool loop runs server-side first). Show a "thinking…" spinner while the POST is in flight; there are no partial tokens.

---

## 2. Authentication

Phone OTP or email OTP → JWT. No passwords. Full request/response examples, failure modes, cooldown, and the channel guard are in [FRONTEND_PAYLOAD_EXAMPLES.md](FRONTEND_PAYLOAD_EXAMPLES.md) §1 — read that before building the sign-in screen.

| Method & path | Auth | Body | Returns |
|---|---|---|---|
| `POST /auth/otp/start` | none | `{ phone: "+2567…" }` | `{ challengeId, expiresInSeconds, devCode? }` (`devCode` only in dev) |
| `POST /auth/otp/verify` | none | `{ challengeId, code }` | `{ userId, accessToken, refreshToken, expiresAt }` |
| `POST /auth/email-otp/start` | none | `{ email: "joash@example.com" }` | `{ challengeId, expiresInSeconds, devCode? }` (`devCode` only in dev) |
| `POST /auth/email-otp/verify` | none | `{ challengeId, code }` | `{ userId, accessToken, refreshToken, expiresAt }` |
| `POST /auth/refresh` | none | `{ refreshToken }` | `{ userId, accessToken, refreshToken, expiresAt }` |

Send `Authorization: Bearer <accessToken>` on every authenticated call. A verified phone **or** verified email is required before the assistant will act — whichever channel the account signed up with. A `challengeId` from the phone `start` call only verifies at the phone `verify` endpoint, never the email one (and vice versa) — see the payload doc for the exact error behavior. Signing up via email vs phone creates separate accounts today; there is no linking between them.

**Do not tie any UX state to the token identity for usage limits.** Limits key off `userId`/`eventId` in the DB — a new login/token does not reset anything (this is intentional; see §7).

---

## 3. The two AI surfaces

### 3a. `POST /assistant` — the primary surface (conversation-scoped)

The organizer just talks; the backend figures out (or asks) which event.

**Request**
```json
{ "message": "John contributed 200k", "conversationId": "uuid-optional" }
```
- Omit `conversationId` to start a new conversation. Persist the returned `conversationId` and send it on every subsequent turn.

**Response** (`ConverseResult`)
```json
{
  "conversationId": "uuid",
  "activeEventId": "uuid | null",
  "reply": "…natural language…",
  "staged": ["pendingId", "…"]
}
```

**Extra tools available only here** (user-level): `create_event`, `switch_event`, `list_my_events`, `get_active_event`. This is the surface that can create events and move between them.

### 3b. `POST /events/:eventId/assistant` — event-fixed surface

Same loop, but the event is pinned by the URL. Use this once the user is "inside" one event (e.g. an event workspace screen).

**Request**: `{ "message": "who hasn't paid?" }`
**Response** (`ChatResult`)
```json
{ "reply": "…", "staged": ["pendingId"], "steps": 3 }
```
(No `conversationId`/`activeEventId` — history is not persisted on this surface; it's a stateless single turn. For multi-turn memory use `/assistant`.)

> **Recommendation:** default the whole app to `POST /assistant` so you get persistence and event-resolution for free. Use `/events/:id/assistant` only for a deliberately event-scoped widget.

---

## 4. Active-event resolution (conversation surface)

`activeEventId` in the response is your source of truth for "which event are we on."

| Situation | What the backend does | `activeEventId` | What you render |
|---|---|---|---|
| User has **0** events, says "create a wedding…" | `create_event` runs, event becomes active | new id | Event header appears; success text in `reply` |
| User has **exactly 1** event | AI can `switch_event` to it and proceed | that id | Proceed normally |
| User has **≥2**, no event chosen, asks a read | Read tool returns `no_active_event` + the event list; **AI asks in `reply`** "which event — Wedding or Funeral?" | `null` | Show the question. **Today the candidate list is in the prose, not structured** — see §8. You *can* pre-empt by calling `GET /events` and rendering an event picker yourself. |
| User says "switch to the funeral" | `switch_event` runs | funeral id | Update the active-event header |

**Switching is sticky:** once switched, the active event **persists across turns** in that conversation (stored on the `conversation` row). You don't need to resend it.

To render an event switcher proactively, call **`GET /events`** (`listMyEvents`) — returns the user's active memberships. When the user picks one, you can either (a) send a message like "switch to X" or (b) just start addressing that event; the AI will `switch_event`.

---

## 5. Confirmation lifecycle (the core write pattern)

Almost every write the AI proposes is **staged**. The turn returns its id in `staged[]`. You then fetch, display, and let the user confirm/reject.

```
POST /assistant ("record John's 200k")
      │  reply: "I've staged a UGX 200,000 payment from John Kato — confirm to record it."
      │  staged: ["pc_123"]
      ▼
GET  /events/:eventId/pending           → list of PendingView
      ▼  render confirmation card(s)
POST /events/:eventId/pending/pc_123/confirm   → ExecutionResult { message, data }
   or
POST /events/:eventId/pending/pc_123/reject    → { id, status: "REJECTED" }
```

**`PendingView`** (from `GET /pending`, the shape you build cards from):
```ts
{ id: string; intent: string; prompt: string; confidence: number | null; status: "PENDING" }
```
- `intent` = the staged tool name (`record_payment`, `correct_pledge`, `merge_people`, `invite_member`, `send_sms_reminders`, `create_budget_item`, …). Use it to pick a card layout.
- `prompt` = human-readable summary already written for you (e.g. *"Record John Kato's payment of 200000?"*, *"Merge … cannot be undone automatically."*). Safe to show verbatim.
- `confidence` = the capture confidence (null for agent-staged and document-staged writes).

**`ExecutionResult`** (from `confirm`): `{ message: string, data: unknown }` — `message` is grounded, e.g. *"Recorded John Kato's payment of 200000. Outstanding on that pledge: 300000."* `data` is the created/updated row.

**Rules for the UI:**
- `staged` non-empty on any AI turn ⇒ there is at least one pending item ⇒ surface a confirmation affordance immediately (badge, card, or inline).
- The `staged` ids **are** the `PendingView.id`s — you can `GET /pending` and match, or optimistically render from `prompt` (fetch `/pending` to get the prompt text, since the AI turn only returns the *ids*, not the prompts).
- Confirm/reject are **event-scoped** endpoints — you need the `eventId`. On the conversation surface, use `activeEventId` from the same response.
- After `confirm`, **re-fetch the affected read** (`/report`, `/people`, etc.) to update tables. The AI reply that staged the item is now stale.
- A pending item is **single-use**; confirming/rejecting twice returns `400 Already confirmed/rejected`.

**Which writes stage vs. execute immediately:**

| Executes immediately (no `/pending`) | Staged (needs confirm) |
|---|---|
| `create_group`, `assign_to_group` | `add_person`, `record_pledge`, `record_payment`, direct contribution |
| `draft_announcement` (creates a **draft**, still not public) | budget add/update/remove |
| — | `correct_pledge`, `correct_payment` |
| — | `merge_people` |
| — | `invite_member` |
| — | `send_reminders` (SMS blast) |
| — | `publish_announcement` (makes a draft public) |

---

## 6. The tools (what the AI can actually do)

These are the capabilities behind the prose. You never call tools directly — but knowing them tells you what user intents are supported and what confirmation cards to expect.

### Read tools (run immediately; mirror the REST reads)
| Tool | Answers | Equivalent REST for rich UI |
|---|---|---|
| `get_event_overview` | "how are we doing?" | `GET /events/:id/report` → `EventReport` |
| `find_contributor` | one person's standing; **returns candidates if the name is ambiguous** | `GET /events/:id/people` |
| `list_contributors` | "who hasn't paid" (status: all/unpaid/partial/complete/outstanding) | `GET /events/:id/people` + `/report` |
| `get_collected_in_period` | money in a date window | — |
| `get_budget` | per-item coverage + gaps | `GET /events/:id/budget`, `/funding` |
| `get_group_contributions` | totals per group/family side | — |
| `get_public_link` | the shareable `/#/p/:slug` link (+token) | `GET /events/:id/public/settings` |

### Write tools (staged unless noted in §5)
`add_person` (contributor), `record_pledge` (CASH/ITEM/SERVICE), `record_payment`, `add_budget_item`, `update_budget_item`, `remove_budget_item`, `correct_pledge`, `correct_payment`, `merge_people`, `create_group`, `assign_to_group`, `draft_announcement`, `publish_announcement`, `send_reminders`, `invite_member`.

### Session tools (conversation surface only)
`create_event`, `switch_event`, `list_my_events`, `get_active_event`.

**Response shapes of the read tools** (useful because you'll render the same data from REST):

`EventReport` (`GET /events/:id/report`):
```ts
{
  target: string | null;              // integer minor units, as STRING
  percentCovered: number | null;
  totalCommitted: string; totalReceived: string; totalOutstanding: string;
  peopleCount: number; contributorCount: number; outstandingContributorCount: number;
  budgetTotal: string; budgetAllocated: string; budgetUnfunded: string;
  biggestGap: { budgetItemId: string; name: string; gap: string } | null;
  topContributors: TopContributor[];
}
```

`budgetBreakdown` / `GET /events/:id/budget` items:
```ts
{ name; target; covered; remaining; status: "FUNDED" | "PARTIALLY_FUNDED" | "UNFUNDED" }
```

`GroupContribution[]`:
```ts
{ groupId; name; kind: GroupKind; memberCount; committed; received; outstanding }
```

`getPublicLink`:
```ts
{ isPublic; slug; publicPath: "/#/p/<slug>[?t=…]"; publicUrl: string|null; tokenRequired; note? }
```
`publicPath` is a client-side (hash-routed) path, not a server route — `/e/:slug` (no hash) 404s when opened fresh, e.g. from an SMS link, since there's no server-side route for it.

**Making the link clickable when it comes back through chat.** `publicUrl` is now a real, complete `https://linktrust.app/#/p/<slug>` (backend has `PUBLIC_APP_URL` configured) — but `ChatResult` has no separate structured field for it the way it does for reports (`reportRefs`). The link only exists inside `reply`, the AI's free-form text, and the AI has been told to state the full `publicUrl` plainly (not markdown-wrapped, not truncated) specifically so a plain autolinker can catch it. That means the chat message renderer needs to actually autolink `https://` substrings in assistant messages — detect `https?://\S+`, wrap in `<a href="…" target="_blank" rel="noopener noreferrer">`, same as any normal chat product. Without that, the fix on the backend still renders as inert text. A hash fragment in the URL (`/#/p/…`) is a completely ordinary `href` target — no special escaping or handling needed.

If a given screen needs a *guaranteed* clickable link rather than depending on chat prose — e.g. a dedicated "Share" button — call `GET /events/:id/public/settings` directly instead of parsing chat text; that's the same data, structured, with no dependency on how the model happened to phrase that turn.

> **Money is always an integer-minor-units STRING** (e.g. `"200000"` = UGX 200,000; UGX has no decimals so minor units == shillings). Never parse to a JS `number` for maths — format for display only. Do **not** compute totals client-side; read them.

---

## 7. Plan limits & how they surface to the UI

Enforced server-side, keyed on stable IDs (uncheatable by re-login/new-token/new-conversation):

| Limit | Free tier | Where it bites |
|---|---|---|
| Active events per **owner** | 1 | `create_event` → `ForbiddenException`; AI explains + suggests upgrade in `reply` |
| Team seats (members + pending invites) | 1 (owner only) | `invite_member` returns a **clarification** message ("your plan has no free seats — upgrade") *before* staging |
| Contributors per event | 25 | `add_person`/pledge writes blocked with a clear message |
| SMS credits | trial grant | `send_reminders` says how many are affordable, or blocks with "top up" |

**Frontend behaviour:** these come back as ordinary `reply` text (and, for the raw REST calls, as HTTP `403`). Detect the upsell moments and offer an **Upgrade** CTA that routes to billing (§9). Don't treat a limit as an error state — it's a conversion moment.

The AI also **always knows today's date** (Africa/Kampala) — "October 2nd this year" resolves to the current year. Don't build any date-context UI to compensate.

---

## 8. Known limitations — read before you design cards

These are **real gaps today**, not future polish. Design around them.

1. **No structured AI state enum.** The response is `{ reply, activeEventId, conversationId, staged }`. There is no `type: "PERSON_SELECTION_REQUIRED"` etc. **Person/event disambiguation and clarifications are prose only.**
   → *Mitigation:* render `reply` as chat; drive rich cards from REST reads and `/pending`. For person disambiguation specifically, if you want a picker, call `GET /events/:id/people` and let the user tap the right one, then send their choice as the next message.

2. **Staged writes return only ids, not prompts.** The AI turn gives you `staged: [id]`; you must `GET /pending` to get each `prompt`/`intent` to render the card.

3. **No streaming / no token-level progress.** One POST, one JSON. Use a spinner. `steps` (event surface) tells you how many tool hops happened — cosmetic only.

4. **In-kind contributions are PARTIAL.** `PledgeType.ITEM`/`SERVICE` exist and a pledge can be typed as such, but the AI's `record_pledge` tool captures **only name + amount + type** — **no quantity, unit, or item description** flow through the AI path. "Peter is bringing 100 chairs" will not persist "100" or "chairs" structurally today. Do not build a rich in-kind fulfilment UI expecting those fields from the AI. (The ledger can hold a typed pledge; the capture path is the gap.)

5. **Documents/extraction is async and worker-driven; the AI chat does not yet ingest uploads.** Upload + extraction exists as **REST** (§9), not through the assistant. There is no "drop an image into chat and the AI reads it" path wired end-to-end yet. Extraction runs on the worker and lands extracted budget lines as **pending confirmations**. Treat document import as its own REST flow, not a chat capability. Statuses: `UPLOADED → PROCESSING → PROCESSED | REQUIRES_REVIEW | FAILED → APPROVED`.

6. **`/events/:id/assistant` has no conversation memory.** Only `/assistant` persists history. Don't split a single conversation across both surfaces.

7. **Merges, corrections, invites, reminders — all staged**; there is no "undo." The confirmation card *is* the safety gate. Make reject prominent.

---

## 9. The rest of the REST surface (for rich UI & non-chat flows)

All authenticated, all `Bearer` JWT, all event routes under `/events/:eventId`.

**Events & membership**
`POST /events` · `GET /events` (My Events) · `GET /events/:id` · `PATCH /events/:id` · `PATCH /events/:id/status` (DRAFT→ACTIVE→PAUSED→CLOSED→ARCHIVED) · `POST /events/:id/members`

**Ledger (rich reads/writes)**
`GET/POST /events/:id/people` · `POST /people/:id/link` · `POST /pledges` · `POST /pledges/:id/correct|cancel` · `GET /pledges/:id/outstanding` · `POST /fulfillments` · `POST /contributions` (direct) · `GET/POST /budget`, `PATCH /budget/items/:id` · `POST /allocations` · `GET /totals` · `GET /report` · `GET /funding` · `GET /audit`

**Capture & confirmations** (event-scoped)
`POST /events/:id/capture` (single-utterance capture, older surface) · `POST /events/:id/assistant` · `GET /events/:id/pending` · `POST /events/:id/pending/:id/confirm|reject`

**Invitations (committee onboarding)**
- `POST /events/:id/invitations` `{ role, invitedPhone?, maxUses?, ttlSeconds? }` → `{ token, role, status, expiresAt }`
- `GET /invitations/:token` — **public landing view** `{ eventName, role, status, valid }` (no auth; leaks only name+role)
- `POST /invitations/:token/accept` (authed) → `{ eventId, role, alreadyMember }`
- `GET /events/:id/invitations` · `POST /events/:id/invitations/:id/revoke`

Invite roles (`EventRole`): `OWNER` (never invitable), `CO_OWNER`, `COORDINATOR`, `FINANCE`, `VIEWER`. The AI **never guesses a role** — if the user doesn't say what the person can do, `invite_member` asks in plain language ("Help run the event / Handle the money / Co-organize / Just view"). Mirror that vocabulary in any role picker; never show raw enum names to end users.

**Onboarding flow to build:** organizer says "invite Joash to the committee" → AI asks what he can do (or you show plain-language choices) → staged → confirm → backend returns a **join link** (`/join/<token>`, or full URL if `PUBLIC_APP_URL` is set) → organizer shares it → invitee opens link (`GET /invitations/:token`) → does phone OTP → `POST /invitations/:token/accept` → member.

**Documents**
`POST /events/:id/files` `{ kind, mimeType, dataBase64, filename, personId? }` · `GET /files/:id/url` (signed) · `POST /events/:id/documents` `{ fileId, kind }` (submit for async extraction) · `GET /events/:id/documents/:id` (poll status). Extracted budget lines appear in `/pending`.

**Transparency (organizer control plane for the public page)**
`GET/PATCH /events/:id/public/settings` · `POST /public/token/rotate` · `DELETE /public/token` · announcements `GET/POST /announcements`, `POST /announcements/:id/publish|archive` · payment instructions `GET/POST/PATCH/DELETE /payment-instructions`.

**Public page (unauthenticated, link-only)** — for the contributor-facing site:
`GET /public/events/:slug[?t=token]` → `PublicEventView` · plus slices `/summary`, `/budget`, `/contributors`, `/announcements`, `/contribute`. ETag + `Cache-Control` supported (send `If-None-Match`). Token may be `?t=` or header `x-akabbo-access-token`.

`PublicEventView` is the **only** shape the public surface returns — it deliberately excludes person ids, phones, notes, audit, AI history, internals. Visibility is config-gated: `contributors`/`budget`/amounts sections may be `null` with a `visibility` object explaining why. Money is minor-units strings. Use `revision` for cache-busting.

**SMS**
`GET /events/:id/sms/preview` (recipients + affordability) · `POST /sms/reminders` · `POST /sms/announcement` · `GET /sms/campaigns` · `GET /sms/delivery`. Delivery states: `queued/sent/delivered/failed/unknown` — never claim "delivered" beyond what `/delivery` reports.

**Billing**
`GET /billing/events/:id/entitlement` · `POST /billing/events/:id/purchase` · `POST /billing/subscribe` · `POST /billing/webhook/muda` (server-to-server; not a frontend call). Payments are **collections-only** Mobile Money via Muda; the webhook is the source of truth for grants. Wire the **Upgrade** CTAs from §7 to `purchase`/`subscribe`.

---

## 10. Rendering playbook (conversation-first, cards where they earn it)

| User intent | Backend reality | Render |
|---|---|---|
| "How are we doing?" / "How much have we raised?" | `get_event_overview` → grounded prose; same data at `GET /report` | Chat reply **+** optional progress card from `/report` |
| "Who hasn't paid?" | `list_contributors` prose | Chat reply **+** table from `/people` filtered by outstanding |
| "Show me the budget" | `get_budget` prose | Budget table from `GET /budget` (per-item FUNDED/PARTIALLY/UNFUNDED) |
| "John contributed 200k" (unique) | staged `record_payment` | Chat reply + **confirmation card** from `/pending` |
| "Annet contributed 200k" (ambiguous) | AI asks in prose | Show the question; optionally a person picker from `/people`, send choice back |
| "Correct John's payment to 200k" | staged `correct_payment` | Correction confirmation card (`intent: correct_payment`) |
| "Merge the two Johns" | staged `merge_people` | High-risk confirmation card, prominent **Reject** |
| "Remind everyone who hasn't paid" | staged `send_reminders` (recipients + credit cost in `prompt`) | Recipient/credit preview card → confirm → then poll `/sms/delivery` |
| "Announce we hit 80%" | `draft_announcement` executes (draft), then staged `publish_announcement` | Draft preview → publish confirmation |
| "Invite Joash to the committee" | AI asks role → staged `invite_member` | Plain-language role choice → confirm → **share-link card** with join URL |
| "Give me the public link" | `get_public_link` | Copyable link card; if `isPublic:false`, show the "turn it on" hint from `note` |
| "Create a wedding for W&S, 25m" | `create_event` executes | New event header + success; may prompt for date next turn |
| Upload a budget photo | REST files→documents→poll→`/pending` | Dedicated import flow (not chat) with extraction-review step |

**Golden rules for the frontend:**
- **Never compute authoritative totals, "who paid", pledge/fulfilment status, or "which event is active" yourself.** Read them.
- **Conversation first**, cards when they add clarity or are needed to *act* (confirmations always get a card).
- Treat `reply` as trusted, already-safe copy — it's written to hide internal ids and jargon. Don't surface raw enum values, tool names, or UUIDs from `data` blobs to end users.
- After any `confirm`, re-fetch the relevant read to refresh cards.

---

## 11. Status legend for this contract

- **IMPLEMENTED NOW:** both AI surfaces; conversation persistence & active-event resolution; all read tools + their REST equivalents; staged-write + `/pending` confirm/reject; create/switch/list events; groups; corrections; merge; invite-member (link + OTP join); reminders & announcements (staged); plan limits; date context; full public transparency surface; billing (Muda collections) + webhook; SMS send/preview/delivery; document upload + async extraction via REST.
- **PARTIALLY IMPLEMENTED:** in-kind capture (type only, no qty/unit/description through AI); document *review* UX (statuses & pending exist; no chat-native upload); person/event disambiguation (works, but text-only — no structured candidate payload).
- **NOT YET IMPLEMENTED:** streaming AI responses; a typed AI response-state enum; chat-native file ingestion; structured candidate/selection payloads; conversation memory on the event-fixed surface; per-phone free-allowance dedup.

*If a capability is not in the IMPLEMENTED list above, do not build UI that assumes it returns structured data — verify against this contract or the code first.*
