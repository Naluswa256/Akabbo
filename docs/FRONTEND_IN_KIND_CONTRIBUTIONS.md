# AKABBO — In-Kind Contributions (money OR items, both via chat and direct API)

A "direct contribution" is money or an item that **already arrived with no prior pledge** — "Peter gave me 100k cash" or "Peter dropped off 2 goats" on the spot. Same shape as a pledge (§ see [FRONTEND_CONTRIBUTIONS_PLEDGES_PANEL.md](FRONTEND_CONTRIBUTIONS_PLEDGES_PANEL.md)): a `Pledge` that's immediately 100% fulfilled by one `Fulfillment`. Until now this path only accepted cash. It now accepts `type`/`description`, the same in-kind fields pledges already have.

---

## Via AI chat — nothing new to build, just be aware

The organizer can now say things like:

- "Peter gave me 2 goats for the introduction"
- "Auntie Sarah brought 50kg of rice, no prior pledge"

The AI resolves this as a **direct contribution** with `type: "ITEM"` and `description: "2 goats"` (or similar), and stages it exactly like any other write — same confirm flow you already handle, same `pending`/`staged` shape as every other AI action in [FRONTEND_AI_INTERACTION_CONTRACT.md](FRONTEND_AI_INTERACTION_CONTRACT.md). The staged prompt text now includes what the item is where relevant, e.g.:

> "Add Peter as a contributor and record their contribution of 0?" *(cash amount is 0 for a pure in-kind gift — the item is the value)*

No new endpoint, no new payload shape on your side for the chat path — this is purely a capability the model now has. The only thing to check: if you're rendering a contribution's confirmed result message, it may now include a parenthetical, e.g. `"Recorded Peter's contribution of 0 (2 goats)."` — same `message`/`data` shape as always ([FRONTEND_AI_INTERACTION_CONTRACT.md](FRONTEND_AI_INTERACTION_CONTRACT.md) §confirm results).

---

## Via direct REST (manual panel, no AI)

```
POST /events/:eventId/contributions
Content-Type: application/json

{
  "personId": "a12f...",
  "value": "0",
  "type": "ITEM",
  "description": "2 goats",
  "note": "optional free text, separate from description"
}
```

New field: **`description`** (optional, 1–500 chars) — what the item/service actually is. Everything else about this endpoint is unchanged:

| Field | Notes |
|---|---|
| `personId` | required |
| `value` | integer minor units digit string. `"0"` for a pure in-kind gift with no assigned cash value; a real number if the organizer wants to record an estimated worth. |
| `type` | `CASH` (default) \| `ITEM` \| `SERVICE` |
| `description` | **new** — only meaningful for `ITEM`/`SERVICE`. Null/omit for cash. |
| `method` | payment method, only meaningful for `CASH` |
| `note` | free text, separate field from `description` — e.g. "dropped off at the venue" |
| `idempotencyKey` | unchanged |

A plain cash contribution is just the same call with `type` omitted (defaults `CASH`) and no `description` — nothing changes for existing integrations.

---

## Reading it back

`GET /events/:eventId/pledges` (the contributions/pledges list — see the panel doc) now returns the in-kind fields on every row:

```json
{
  "id": "...",
  "personName": "Peter",
  "type": "ITEM",
  "committedValue": "0",
  "status": "FULFILLED",
  "outstanding": "0",
  "description": "2 goats",
  "quantity": null,
  "unit": null,
  "estimatedValue": null,
  "fulfillments": [ { "id": "...", "value": "0", "kind": "DELIVERY", "method": "UNKNOWN", ... } ]
}
```

For display: show `description` as the headline when `type !== "CASH"` instead of (or alongside) the money figure — "2 goats" reads better than "UGX 0". `quantity`/`unit`/`estimatedValue` exist in the data model (mirroring in-kind **pledges**) but nothing in the AI or REST contribution path sets them yet — they'll be `null` for every contribution today. They're only populated for pledges created through document extraction. Ask if the panel needs to let organizers set quantity/unit/estimated value directly; that's a small additional field set, not built yet.

The fulfillment/split itself has `kind: "DELIVERY"` instead of `"PAYMENT"` for non-cash contributions — useful if you want a different icon/label per split (💵 payment vs 📦 delivery).
