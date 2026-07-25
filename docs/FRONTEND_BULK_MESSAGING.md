# AKABBO — Bulk Reminders & Announcements (manual panel, no AI chat)

For building a dedicated panel where the organizer searches/selects contributors and triggers SMS reminders or announcements directly — no AI involved. All endpoints below are authenticated (`Bearer` JWT), event-scoped under `/events/:eventId`, and are the exact same domain services the AI chat path uses — nothing AI-specific about them.

**This document describes newly-added capability** (targeted recipients + contributor IDs in the report) alongside what already existed. It has not yet been through the full test suite — typecheck is clean, but treat the `personIds` targeting as freshly landed.

---

## 1. Search/browse contributors (the picker list)

```
GET /events/:eventId/report/contributors?status=outstanding&search=nam&page=1&pageSize=25&sort=amount&dir=desc
```

Query params (all optional):
| Param | Values | Meaning |
|---|---|---|
| `status` | `all` \| `unpaid` \| `partial` \| `complete` \| `outstanding` | Same vocabulary as everywhere else in this API. `outstanding` = still owes something — this is what "pending balances" means. |
| `search` | string | Case-insensitive substring match on name. |
| `groupName` | string | Filter to a contributor group (e.g. "bride's side"). |
| `minAmount` / `maxAmount` | integer minor units | Filter by amount received. |
| `sort` | `amount` \| `name` | |
| `dir` | `asc` \| `desc` | |
| `page` / `pageSize` | integers | `pageSize` capped at 100. |

**Response:**
```json
{
  "totalRecords": 42,
  "totalAmount": "18000000",
  "currency": "UGX",
  "page": 1,
  "pageSize": 25,
  "totalPages": 2,
  "rows": [
    {
      "personId": "b1f2c3d4-...",
      "name": "Namayanja Prossy",
      "group": "Church",
      "amount": "0",
      "outstanding": "30000",
      "status": "unpaid"
    }
  ]
}
```

`personId` is what you collect from checkboxes and pass to the send endpoints below. `status` here is a slightly different vocabulary than the query-param filter — it's the per-row computed state: `no_pledge | unpaid | partial | complete`.

**"Everyone with pending balances"** = `?status=outstanding` (or just read `outstanding` off each row client-side if you're already paginating).

CSV export of the same filtered set: `GET /events/:eventId/report/contributors/export` (same query params, returns `text/csv`).

---

## 2. Reminders — preview, then send

### 2a. Preview (always call this before showing a send button)

```
GET /events/:eventId/sms/preview
GET /events/:eventId/sms/preview?personIds=b1f2c3d4-...&personIds=c2a3d4e5-...
```

- **No `personIds`** → previews the default set: everyone with an outstanding balance *and* a phone on file.
- **With `personIds`** (repeat the query param per id) → previews exactly that selection.

```json
{
  "recipientCount": 12,
  "estimatedCredits": 12,
  "smsBalance": 300,
  "affordable": 12
}
```

`affordable` may be less than `recipientCount` if the event is low on SMS credits — show this before the user confirms, e.g. *"12 recipients selected, but you can only afford 9 — top up to reach everyone."*

### 2b. Send

```
POST /events/:eventId/sms/reminders
Content-Type: application/json

{ "body": "Hi {name}, friendly reminder — you still have UGX {outstanding} outstanding for the wedding." }
```

Or targeted:
```json
{
  "body": "Hi {name}, friendly reminder about your pledge.",
  "personIds": ["b1f2c3d4-...", "c2a3d4e5-..."]
}
```

- `{name}` in the body is replaced per-recipient with their display name. (There's no `{outstanding}` template variable server-side today — if you want the amount in the message, interpolate it into `body` yourself before sending, per-recipient batching isn't supported — the same `body` string goes to everyone in one campaign.)
- **Omit `personIds`** → sends to everyone outstanding-with-phone (the "remind almost everyone" flow).
- **Pass `personIds`** → sends to exactly that list. Anyone in the list without a phone number on file is silently skipped (same as the default flow) — check the response for how many were actually queued.
- `personIds` must belong to this event — the query is RLS-scoped, so an id from another event resolves to nothing rather than leaking data or erroring.

**Response:**
```json
{ "campaignId": "e5f6a7b8-...", "queued": 12, "skipped": 0 }
```

`skipped` > 0 means some recipients were dropped because the event ran out of SMS credits mid-send (never partway through a message — it's a hard stop at the credit boundary). Show this plainly: *"Sent to 9 of 12 — you ran out of SMS credits."*

**Sending is async.** This response confirms *queuing*, not delivery — the worker sends the actual messages seconds later. Poll delivery status (§4) rather than assuming success.

---

## 3. Announcements — same shape, different default audience

```
POST /events/:eventId/sms/announcement
{ "body": "We've reached 80% of our target! Thank you all." }
```
or targeted the same way with `personIds`. The only difference from reminders: the **default** recipient set (when `personIds` is omitted) is *everyone with a phone*, not just those outstanding — an announcement is for all contributors, paid or not.

There's a separate, non-SMS announcement flow too (publishing text to the public event page): `POST /events/:eventId/announcements` → `POST /events/:eventId/announcements/:id/publish`. That's unrelated to SMS — announcements to the public page and SMS announcements are two different things that happen to share the word.

---

## 4. Delivery & campaign history

```
GET /events/:eventId/sms/campaigns
```
```json
[
  {
    "id": "e5f6a7b8-...",
    "kind": "REMINDER",
    "body": "Hi {name}, friendly reminder...",
    "status": "SENT",
    "recipientCount": 12,
    "createdAt": "2026-07-25T10:00:00.000Z"
  }
]
```
`status`: `QUEUED → SENDING → SENT | PARTIAL | FAILED`. `FAILED` with `recipientCount: 0` means nobody matched the filter/selection at all (e.g. everyone selected had no phone) — this is the exact failure mode that was previously silent; it's now logged server-side too.

```
GET /events/:eventId/sms/delivery?campaignId=e5f6a7b8-...
```
```json
{ "sent": ["Namayanja Prossy"], "failed": [], "pending": [] }
```
Omit `campaignId` to get delivery status across the whole event. Names only (never phone numbers, by design). `pending` means still queued for the worker to process — poll again shortly if you show a live status view.

---

## 5. Recommended panel flow

```
1. Load contributor list  → GET /report/contributors?status=outstanding (default view: "who owes")
2. User searches/filters  → re-query with search/status/group params
3. User picks a mode:
   a. "Remind everyone outstanding" → skip selection, call preview with no personIds
   b. "Select specific people"      → checkboxes collect personId from each row
4. Show preview            → GET /sms/preview[?personIds=...]  (recipient count, credits, affordability)
5. User writes the message, confirms
6. Send                    → POST /sms/reminders or /sms/announcement (with or without personIds)
7. Show queued/skipped from the response
8. Poll delivery           → GET /sms/delivery?campaignId=...  until nothing is `pending`
```

## 6. What this does NOT support yet

- No per-recipient message personalization beyond `{name}` — one `body` string per campaign.
- No scheduling ("send this tomorrow at 9am") — sends are immediate (queued now, delivered within seconds by the worker).
- No delivery webhooks/push — the frontend must poll `GET /sms/delivery`.
