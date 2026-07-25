# AKABBO — Chat/Conversation Persistence (resume after refresh)

## Root cause of the bug you're seeing

Conversations and messages were **already being saved server-side** on every turn (`conversation` + `message` tables) — but there was **no read endpoint at all** to fetch them back. `POST /assistant` was the only route that existed. So the frontend had nowhere to reload history from after a refresh, and was necessarily holding the whole transcript in local component state only — which is exactly what disappears on refresh. This wasn't a frontend mistake; the API to fix it didn't exist until now.

Two new endpoints close this gap.

---

## 1. List the user's conversations (for "resume where you left off")

```
GET /assistant/conversations
Authorization: Bearer <token>
```

**Response** — most recently active first:
```json
[
  {
    "id": "c1a2b3d4-...",
    "title": null,
    "activeEventId": "210d2484-2ce7-4160-bfe7-7895af763ce2",
    "createdAt": "2026-07-24T10:00:00.000Z",
    "updatedAt": "2026-07-25T13:32:00.710Z"
  }
]
```

- `updatedAt` reflects real last-activity (bumped on every message, not just when the active event changes) — sort is already newest-first, no client-side re-sorting needed.
- `title` is **always `null` today** — there's no auto-titling yet. Derive a display label yourself: if `activeEventId` is set, look up that event's name (you already have it from `GET /events`) and show e.g. *"Marvin & Ashley Introduction"*; if `activeEventId` is null, fall back to something like the first user message (truncated) or the `createdAt` date.
- Capped at the 20 most recent conversations.

## 2. Fetch a conversation's full message history

```
GET /assistant/conversations/:id/messages
Authorization: Bearer <token>
```

**Response** — oldest first, ready to render directly as chat bubbles:
```json
[
  { "id": "m1...", "role": "user", "content": "hey", "createdAt": "2026-07-25T13:30:00.000Z" },
  { "id": "m2...", "role": "assistant", "content": "Hi! How can I help?", "createdAt": "2026-07-25T13:30:02.000Z" }
]
```

- `role` is exactly `"user" | "assistant"` — maps directly to your chat bubble alignment.
- **Ownership-enforced**: this conversation table isn't event-scoped RLS (a conversation exists before any event is chosen and can switch between events), so ownership is checked explicitly by `userId` here. Requesting another user's conversation id returns `403 Forbidden`; an unknown id returns `404`.
- No pagination yet — returns the full history in one response. Fine for normal chat lengths; if a conversation gets very long this may need a `?before=` cursor later, but don't build for that now.
- Note this is the **full, unabridged** history for display. It's distinct from what the AI itself sees per turn (bounded to the last 20 turns internally, for prompt size) — you don't need to replicate that limit in the UI.

---

## 3. Recommended flow

```
On app load / chat panel mount:
  1. GET /assistant/conversations
     - Empty?      → show the normal empty/welcome state, start a fresh
                      conversation on the user's first message (omit
                      conversationId, exactly as today).
     - Non-empty?  → auto-resume the most recent one (rows[0]), or show a
                      "recent conversations" picker if you want the user to
                      choose — your call, both are reasonable.
  2. GET /assistant/conversations/:id/messages
     → render as the existing chat history, scrolled to bottom.
  3. Continue chatting normally:
     POST /assistant { message, conversationId: <that id> }
     — same contract as before, nothing changed here.
```

**Important — check this on the frontend regardless of the fix above:** confirm you're actually storing and re-sending the `conversationId` that `POST /assistant` returns on every subsequent message *within* a session, not just across refreshes. If a "new" conversation is being started server-side on every single message today (never passing `conversationId` back), that's a separate bug from the one this doc fixes — every message would land in its own 1-message conversation, and `staged[]`/active-event context would never carry between turns either. Worth verifying directly: send two messages in the same UI session and check via `GET /assistant/conversations` whether that produced one conversation with 4 messages or two conversations with 2 each.

---

## What this does NOT solve

- **No auto-generated titles.** `title` is always `null`. If you want a proper "ChatGPT-style" sidebar with meaningful conversation names, that needs a separate feature (either client-derived from the active event / first message, or a future backend addition).
- **No delete/archive conversation** endpoint.
- **No pagination on message history** — fine for now, flagged above as a future concern only.
- **No live streaming / websocket** — this is unrelated to persistence; `POST /assistant` is still a single request/response per turn, same as documented elsewhere.
