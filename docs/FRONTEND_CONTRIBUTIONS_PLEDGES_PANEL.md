# AKABBO — Manual Contributions & Pledges Edit Panel (no AI chat)

For the panel where the organizer lists everyone who has pledged or contributed, and can click into any entry to correct it — pledges specifically support adding more than one split (partial payment) until the pledge is fully fulfilled, after which the API refuses more. All endpoints below are authenticated (`Bearer` JWT), event-scoped under `/events/:eventId`, and are the same domain services the AI chat path uses (`FulfillmentService`, `PledgeService`) — nothing AI-specific about them.

**Newly added for this panel:** `GET /events/:eventId/pledges` (list-with-splits) and `POST /events/:eventId/fulfillments/:fulfillmentId/correct` (edit a single split). Everything else already existed. All of it is typecheck-clean; not yet exercised by an integration test.

---

## The model, in one paragraph

A `Person` has zero or more `Pledge`s. Each pledge has a `committedValue` (what they said they'd give) and zero or more `Fulfillment`s — the splits, i.e. each individual payment recorded against it. `outstanding = committedValue − Σ(fulfillments.value)`, always derived, never stored. A pledge someone paid off in one go, a pledge paid in three installments, and a "gave me 100k cash on the spot with no prior pledge" direct contribution are **all the same `Pledge` + `Fulfillment[]` shape** — a direct contribution is just a pledge that's immediately 100% fulfilled by its one split. There is no separate "contribution" entity to list — `GET /events/:eventId/pledges` returns everything.

`status` is derived the same way everywhere: `PLEDGED` (nothing paid yet) → `PARTIALLY_FULFILLED` → `FULFILLED` (outstanding = 0), or `CANCELLED`. **Once a pledge is `FULFILLED`, the API rejects any further split** — that's the "can't add more once fully paid" rule enforced server-side, not just a UI affordance.

---

## 1. List view

```
GET /events/:eventId/pledges
```

Returns every pledge in the event, newest first, each with its person and full split history:

```json
[
  {
    "id": "b7e1...",
    "personId": "a12f...",
    "personName": "John Kato",
    "personPhone": "+256700000000",
    "type": "CASH",
    "committedValue": "1000000",
    "status": "PARTIALLY_FULFILLED",
    "source": "ai_from_chat",
    "outstanding": "800000",
    "description": null,
    "quantity": null,
    "unit": null,
    "estimatedValue": null,
    "targetBudgetItemId": null,
    "targetBudgetItemName": null,
    "fulfillments": [
      {
        "id": "f001...",
        "value": "200000",
        "kind": "PAYMENT",
        "method": "MTN",
        "verificationStatus": "REPORTED",
        "note": null,
        "occurredAt": "2026-07-20T10:15:00.000Z"
      }
    ]
  }
]
```

`description`/`quantity`/`unit`/`estimatedValue` are only ever non-null when `type` is `ITEM` or `SERVICE` — see [FRONTEND_IN_KIND_CONTRIBUTIONS.md](FRONTEND_IN_KIND_CONTRIBUTIONS.md) for the full in-kind shape and how to render it.

**`targetBudgetItemId`/`targetBudgetItemName` (new)** — set when this pledge/contribution is earmarked against a planned budget line (e.g. a "100 cartons of water" pledge linked to a "Water" budget item). Both null means it's outside the planned budget — a normal, valid state, not missing data. Set at creation time via `targetBudgetItemId` on `POST /events/:eventId/pledges` or `POST /events/:eventId/contributions`; there's no endpoint yet to link an existing pledge after the fact. See [FRONTEND_BUDGET_PANEL.md](FRONTEND_BUDGET_PANEL.md) §4c for the budget-item side of this (which pledges are linked to a given line).

All money fields (`committedValue`, `outstanding`, each split's `value`) are **plain digit strings, integer minor units** (UGX has no minor units, so this is just the shillings amount) — format them for display yourself (thousands separators etc.), the API never adds formatting. No pagination yet — if an event has hundreds of pledges and this becomes slow, ask and we'll add `page`/`pageSize` matching the `report/contributors` endpoint's pattern.

`type` is `CASH | ITEM | SERVICE`.

### Drilling into one person (new: `?personId=`)

Pass `?personId=<id>` to get just one contributor's pledges/contributions — this is the endpoint for a "click a person, see everything they've contributed" detail view:

```
GET /events/:eventId/pledges?personId=a12f...
```

Same response shape as above, filtered to that person. To get the person's own details (name/phone/whether they've claimed an account) alongside it, call the existing contributor list — `GET /events/:eventId/people` — and match on `id`; there's no separate "get one person" endpoint, but the list is cheap and typically small (dozens to low hundreds per event):

```json
// GET /events/:eventId/people → one row per contributor
{ "id": "a12f...", "displayName": "John Kato", "phone": "+256700000000", "source": "human_typed", "userId": null }
```

A typical "person detail" screen: `GET /events/:eventId/people` once to populate the picker/header, then `GET /events/:eventId/pledges?personId=<selected id>` for that person's contributions — each one editable via the correction endpoints in §2–4 below.

---

## 2. Editing a pledge (the commitment itself)

Corrects `committedValue` — e.g. "actually he pledged 1.2M, not 1M."

```
POST /events/:eventId/pledges/:pledgeId/correct
Content-Type: application/json

{ "committedValue": "1200000" }
```

Returns the updated `Pledge` (same shape as one list-row minus `fulfillments`/`personName`/`outstanding` — re-fetch the list or splice locally). Note: this does **not** check the new value against existing splits — you can lower `committedValue` below what's already been paid (e.g. correcting a data-entry mistake where the pledge was overstated). If that happens, `status` will show `FULFILLED` with `outstanding: "0"` even though splits sum higher than `committedValue` — that's expected, not a bug.

Cancelling a pledge entirely (e.g. it was a mistake, or the person backed out):

```
POST /events/:eventId/pledges/:pledgeId/cancel
```

No body. Sets `status: "CANCELLED"`. Cancelled pledges still appear in the list (for history/audit) — filter them out client-side if the panel shouldn't show them by default.

---

## 3. Adding a split (new partial payment)

```
POST /events/:eventId/fulfillments
Content-Type: application/json

{
  "pledgeId": "b7e1...",
  "value": "300000",
  "method": "MTN",
  "note": "optional free text",
  "idempotencyKey": "optional-retry-safe-key"
}
```

`method` is optional (`MTN | AIRTEL | CASH | BANK | OTHER | UNKNOWN`, defaults `UNKNOWN`). `kind` defaults `PAYMENT` (the other value, `DELIVERY`, is for in-kind pledges).

**Overpayment guard (new):** if this split would push the pledge's total fulfilled past its `committedValue`, the API now rejects it with `403 Forbidden`:

```json
{
  "statusCode": 403,
  "message": "This pledge is already fully accounted for beyond that: only 800,000 remains outstanding (committed 1,000,000, already recorded 200,000). Correct the pledge amount first if it should be higher.",
  "error": "Forbidden"
}
```

Drive the "disable add-split once fully paid" UI state off `outstanding === "0"` (or `status === "FULFILLED"`) from the list response — the 403 is the server-side backstop if that state is ever stale (e.g. two tabs open), not the primary UX.

---

## 4. Editing an existing split (new endpoint)

```
POST /events/:eventId/fulfillments/:fulfillmentId/correct
Content-Type: application/json

{ "value": "250000" }
```

Returns the updated `Fulfillment` view:

```json
{
  "id": "f001...",
  "pledgeId": "b7e1...",
  "value": "250000",
  "kind": "PAYMENT",
  "method": "MTN",
  "verificationStatus": "REPORTED",
  "pledgeStatus": "PARTIALLY_FULFILLED",
  "outstanding": "750000"
}
```

Same overpayment guard as above, except the split being edited is excluded from the "already recorded" sum first (so raising *this* split's own value up to its fair share never false-positives against itself) — only raising it far enough to push the pledge's *total* past `committedValue` gets rejected.

There's no separate "delete a split" endpoint — if a split was recorded in error, correct its value to `"0"` (still a valid `Fulfillment` row, just contributing nothing) rather than deleting it; every correction is audit-logged (old value → new value), so this preserves history the way pledge corrections already do.

---

## 5. Scan a written list (`kind: "CONTRIBUTION_LIST"`) — now real

The dependency the "Scan a written list" feature flagged is resolved: `Document.kind` used to be recorded but never actually consulted — every upload, regardless of declared kind, went through the budget-line extraction path. That's why an earlier real test of this exact flow came back as `Added budget item "Mbonye Emma" (20,000)` for each row instead of a pledge — the mechanism worked, the meaning was wrong. `CONTRIBUTION_LIST` now has its own real extraction contract and lands genuine pledge/payment proposals. Nothing about the request/poll/diff flow you already built needs to change — the fix is entirely server-side — but a few real behaviors to design around:

- **Cards now read like pledge confirmations, not budget-item ones** — the same `prompt` text chat-based capture already produces (e.g. "I read Peter's pledge as UGX 1,500,000 — right?"), rendered by your existing `ActionPreview` cards exactly as before. An in-kind row ("Sarah — chairs") shows the item description in the card text, the same fix already in place for chat-staged in-kind pledges.
- **Fixed (2026-08-04): every readable row now becomes a pending confirmation — none bypass review anymore.** A real bug meant a row Gemini was highly confident about (a plain "Name paid/pledged amount" line, which is most of them) got written straight to the ledger with no card and no review step at all — the diff would simply show fewer cards than rows, with the data silently already recorded. That's fixed: document-extracted rows always stage now, exactly like chat-staged ones, regardless of how confident the read was. Your diff-based counting is still exactly right and doesn't need to change — every successfully-parsed row will now actually appear as a new `PendingConfirmation` to diff against.
- **Re-uploading the same photo now stages duplicate-looking cards too, instead of silently filtering them.** Duplicate detection moved to happen at *confirm* time (same as chat) rather than during extraction — so confirming a card for a payment that turns out to already exist will surface the existing duplicate-suspected error your confirm flow already handles for chat-originated cards, rather than the row never appearing at all.
- **A name too ambiguous to resolve, or a row with no usable amount and no in-kind description, is still skipped server-side** rather than blocking the rest of the document — that part is unchanged. The organizer may see fewer cards than rows on the page with no on-page indication why; a real v1 gap, not a bug in your diff logic.
- **`FAILED` with nothing staged now carries one of several specific messages** depending on why — e.g. "No contributions could be read from this document" (genuinely illegible), "N contributions need clarification... open the chat" (ambiguous names), or a mixed summary like "No contributions were staged: 2 already recorded, 1 unreadable." Show `error` verbatim; still worth keeping a generic fallback for any message shape you don't specifically branch on.
- **"paid" vs "pledged" on the page maps to direct-contribution vs pledge-only** — a row marked as already given routes toward an immediately-fulfilled record; a row read as promised-but-not-yet-given stages as a pledge with nothing paid. A row with no status mark at all is treated as unknown/pledge-only, never guessed as paid.
- **Partial-payment context (e.g. "pledged 500,000, paid 200,000 so far") is captured but not yet surfaced to you** — the extraction preserves it in a `notes` field that isn't exposed through any endpoint the panel calls today. The staged card reflects the pledged amount. Ask if you want that detail visible on the card and we'll expose it.

---

## Quick reference

| Action | Endpoint |
|---|---|
| List everything (pledges + contributions + their splits) | `GET /events/:eventId/pledges` |
| List one person's pledges/contributions | `GET /events/:eventId/pledges?personId=<id>` |
| List/see people (for the person picker/header) | `GET /events/:eventId/people` |
| Correct a pledge's committed amount | `POST /events/:eventId/pledges/:pledgeId/correct` |
| Cancel a pledge | `POST /events/:eventId/pledges/:pledgeId/cancel` |
| Add a new split | `POST /events/:eventId/fulfillments` |
| Edit an existing split | `POST /events/:eventId/fulfillments/:fulfillmentId/correct` |
| Scan a written list → staged pledges | `POST /events/:eventId/documents` (`kind: "CONTRIBUTION_LIST"`) → poll → diff pending |

All money in/out is a plain digit string of integer minor units — never comma-formatted by the API, never floats.
