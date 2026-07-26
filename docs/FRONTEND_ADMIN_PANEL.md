# AKABBO — Admin Panel: Users/Plans + Conversation Inbox

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

## 3. What this does NOT do

- **No write actions** — this is read-only reporting. Changing a user's plan, banning someone, editing a conversation — none of that exists here.
- **No search/filter server-side** on users or conversations (by phone, by plan, by date range) — filter/sort client-side on the returned list for now.
- **No pagination on `/admin/users`** (flat 200-row cap) — fine short-term.
- **This is the same secret as `/ai/learning/*`** — if you're already building an admin shell for that, this slots into the same screen/auth gate rather than needing a separate login.
