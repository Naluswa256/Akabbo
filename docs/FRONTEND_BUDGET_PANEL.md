# AKABBO — Budget Viewer Panel (spreadsheet-style, with coverage)

Everything needed for a standalone budget panel: a spreadsheet-like list of every budget line, its funding coverage, editing lines, and marking a line "covered" — either by hand from the panel or by the organizer asking the AI in chat. This is its own panel, separate from the contributions/pledges edit panel ([FRONTEND_CONTRIBUTIONS_PLEDGES_PANEL.md](FRONTEND_CONTRIBUTIONS_PLEDGES_PANEL.md)) and the public transparency page (main payload doc §3) — though all three end up reading/writing the same underlying ledger data.

---

## 1. The model, in one paragraph

A `BudgetItem` is a planned line (name + target amount). An `Allocation` earmarks (part of) an already-received payment (`Fulfillment`) against a specific budget item. `covered = Σ allocations for that item`, `remaining = target − covered`, `status` (`UNFUNDED | PARTIALLY_FUNDED | FUNDED`) is **always derived from real allocated money — never a settable flag**, same rule as every other status in this app (pledge status, fulfillment status). There is no `PATCH .../covered` endpoint and there won't be one; a bare checkbox would let the sheet show funding that never actually happened.

---

## 2. List every item with its coverage (the spreadsheet view)

```http
GET /events/:id/report
```

Use `report`, **not** plain `/budget` — `/budget` only returns the planned lines (name/target), not coverage. `report`'s `budget.items[]` carries the full spreadsheet-row shape:

```json
{
  "budget": {
    "total": "15030000",
    "covered": "5000000",
    "remaining": "10030000",
    "items": [
      { "name": "Catering", "target": "5000000", "covered": "5000000", "remaining": "0",       "status": "FUNDED" },
      { "name": "Venue",    "target": "8000000", "covered": "0",       "remaining": "8000000", "status": "UNFUNDED" },
      { "name": "Photography", "target": "2000000", "covered": "1000000", "remaining": "1000000", "status": "PARTIALLY_FUNDED" }
    ]
  }
}
```

### 2a. The "All Items / Needs Money / Fully Paid" filter

This is **client-side only** — every item already carries `status` in the one `/report` call above, so there's no separate filtered endpoint and no server round-trip per filter click. Map the 3-state `status` down to the 2 non-"All" filter options:

| Filter option | Matches |
|---|---|
| **All Items** | everything, no filter |
| **Needs Money** | `status === 'UNFUNDED' \|\| status === 'PARTIALLY_FUNDED'` — anything not yet fully covered |
| **Fully Paid** | `status === 'FUNDED'` |

Filter the `budget.items[]` array you already have in memory; don't re-fetch on filter change. If a future panel needs `PARTIALLY_FUNDED` broken out as its own third option (not just folded into "Needs Money"), that's still the same field — just a 3-way split instead of 2-way, no backend change either way.

`report` also gives you the whole-event totals (pledged/received/outstanding) in the same call if the panel wants a header summary alongside the budget table — see the main payload doc's `/report` example.

For editing (item ids, provenance, optimistic-lock version) rather than just display, use the plain list instead:

```http
GET /events/:id/budget      → BudgetItemView[]
```
```json
[
  { "id": "bi_1", "name": "Catering", "targetValue": "5000000", "source": "organizer",        "sourceDocumentId": null,  "version": 1 },
  { "id": "bi_2", "name": "Venue",    "targetValue": "8000000", "source": "ai_from_document",  "sourceDocumentId": "doc_9", "version": 2 }
]
```
- `source` (`ProvenanceSource`): `organizer | ai_from_chat | ai_from_document | …` — a line read off an uploaded budget photo/PDF is `ai_from_document` and links back to its source document.
- `version` is an optimistic-lock counter — pass it back as `expectedVersion` on update so a concurrent edit doesn't get silently clobbered.

A practical panel fetches both: `/budget` for `id`/`version` (needed to edit), `/report` for the live coverage numbers — match rows by `name`.

---

## 3. Add / edit a line

```http
POST  /events/:id/budget/items        { "name": "Photography", "targetValue": "2000000" }
PATCH /events/:id/budget/items/bi_2   { "targetValue": "9000000", "isPublic": true, "expectedVersion": 2 }
```
Returns the updated `BudgetItemView`. `isPublic` only matters when the event's public-page budget visibility is `PARTIALLY_PUBLIC` (main doc §3.4) — it flags whether this specific line shows on the public page.

Via AI chat instead (staged, same confirm flow as everything else):
```http
POST /assistant   { "message": "add catering at 5m", "conversationId": "conv_1" }
```
→ reply `"Add budget item \"Catering\" at 5000000? Confirm and I'll add it."`, `staged: ["pc_bud_1"]` → `GET /events/:id/pending` to render the card → `POST /events/:id/pending/pc_bud_1/confirm`.

---

## 4. Marking a line "covered"

Since coverage is derived, "mark as covered" means **earmarking a real payment against that line** — `status` flips to `PARTIALLY_FUNDED`/`FUNDED` automatically once enough is allocated, and it's the exact same live number the AI and the public page both read. Nothing to separately sync — allocate once, every surface updates.

### 4a. Manual, from the panel (2 calls, both pre-existing)

```http
POST /events/:id/contributions       { "personId": "...", "value": "200000", "method": "MTN" }
→ 201 { "id": "<fulfillmentId>", ... }

POST /events/:id/allocations         { "fulfillmentId": "<fulfillmentId>", "budgetItemId": "bi_2", "value": "200000" }
→ 201 { "id": "...", "fulfillmentId": "...", "budgetItemId": "bi_2", "value": "200000" }
```

If the money was already recorded as a payment against an existing pledge (not a fresh direct contribution), skip the first call — get that payment's `fulfillmentId` from `GET /events/:id/pledges` (each split's `id`, see the contributions/pledges panel doc) and allocate directly from it.

### 4b. Via AI chat

The organizer can say things like *"allocate John's payment to catering"* or *"put 200k of Sarah's money toward the venue"*. The AI resolves the named person's most recent payment that still has unallocated value left, stages the same allocation, and the confirm flow is identical to every other staged action. If they have no unallocated payment, or ask for more than what's left, the AI asks for clarification instead of guessing — you'll see that as a normal `clarification` chat response, not an error.

### 4c. Reading back *who* funded a line (new)

Coverage alone (`covered: "140000"`) doesn't say who it came from — this is the endpoint for that, e.g. a "who paid for this" expand/tooltip on each budget row:

```http
GET /events/:id/budget/items/:itemId/funders
```
```json
{
  "status": "resolved",
  "itemName": "Certificates",
  "target": "140000",
  "covered": "140000",
  "funders": [
    { "displayName": "David Kabasi", "value": "140000", "occurredAt": "2026-07-29T10:15:00.000Z" }
  ]
}
```

`funders` is one row per payment allocated to this item (ordered oldest first) — a line funded by three different people shows three rows, and `covered` is their sum (matches the same figure `/report`'s `budget.items[].covered` already gives you). `status` is `"not_found"` if the item id doesn't exist in this event — no `"ambiguous"` case on this route since you're passing an id, not a name (the AI chat equivalent resolves by name and can hit that case; REST doesn't).

Same capability is available to the AI chat now too (`get_budget_item_funders`) — "who funded X" / "who paid for X" now has a real answer instead of the generic "the system doesn't display that" response you may have seen before.

---

## 5. Quick reference

| Action | Endpoint |
|---|---|
| Spreadsheet view (with coverage) | `GET /events/:id/report` → `budget.items[]` |
| Edit-mode list (ids, version, provenance) | `GET /events/:id/budget` |
| Add a line | `POST /events/:id/budget/items` |
| Edit a line | `PATCH /events/:id/budget/items/:itemId` |
| Record money that will cover a line | `POST /events/:id/contributions` |
| Earmark payment → budget line ("mark covered") | `POST /events/:id/allocations` |
| Who funded a specific line | `GET /events/:id/budget/items/:itemId/funders` |
| Any of the above via chat | `POST /assistant` (staged, confirm via `/pending/:id/confirm`) |

All money fields are plain digit strings of integer minor units — format for display yourself, never comma-formatted or floats from the API.
