# AKABBO — Monetization, Unit Economics & Metering Architecture

**Author:** Technical Founder / Principal Architect
**Version:** 0.1
**Date:** 19 July 2026
**Companion to:** *Akabbo Pre-Architecture Technical Blueprint v0.1*
**Assumptions baked in:** UGX/USD = **3,700** (mid-July 2026 spot ≈ 3,705); SMS cost to us ≈ **UGX 30 (~$0.008)**; Gemini 2.5 Flash ≈ **$0.30 / $2.50 per 1M tokens** (in/out). Sources at end.

---

## 0. The one insight that determines everything

I modeled the full variable cost of running a real event end-to-end (below). The result is unambiguous and it dictates the entire pricing and metering design:

> **SMS is ~85–90% of our variable cost per event. AI/LLM is ~5–10%. Storage and everything else is rounding error.**

Two consequences that I am treating as load-bearing decisions:

1. **We give the AI away and charge for reach + scale.** The LLM capture experience is our differentiator, it's *cheap* (fractions of a cent), and it's habit-forming. Metering it for billing would be user-hostile ("you've run out of chat") for almost no margin protection. So AI is effectively unlimited on every paid tier and generous even on free. **What we actually sell is: the ability to reach contributors (SMS), the scale of the event (contributor count), and professional outputs (reports, sender ID, seats).**

2. **The billing system must meter SMS precisely from line one of code, and meter AI only for observability, not for billing.** SMS is a hard, decrementing, pre-authorized credit balance. AI is a logged counter we watch for cost/abuse but never gate a paying user on. If we get SMS metering wrong, we lose money on every event. If we "get AI metering wrong," nothing bad happens.

Everything below follows from this.

---

## 1. Unit cost model — what each action costs us

All costs to *us*, in USD. Token estimates assume the tiered routing from the blueprint (§9): a large share of capture turns are handled by deterministic parsing at $0, and prompt-caching of the tool schema keeps input cost low.

| Action | What happens | Cost to us | Notes |
|---|---|---|---|
| **Deterministic capture turn** | Regex/small-classifier match ("John paid 200k") | **$0.000** | Target: 40–55% of capture turns |
| **LLM capture turn** | Gemini Flash: ~1.5k in + ~0.3k out, structured tool call | **~$0.0013** | With retries/overhead budget ~$0.0015 |
| **LLM query turn** | "Who owes?" → SQL result phrased by model | **~$0.0015** | Answer grounded in DB, not model |
| **Document extraction** | Multimodal budget/list photo → structured rows | **~$0.02** | Larger output; async on worker |
| **AI summary / report narrative** | Bigger context in, prose out | **~$0.005** | |
| **1 SMS (outbound)** | Africa's Talking / local provider | **~$0.008** | UGX ~30. **This is the cost driver.** |
| **Document storage (R2)** | Photos/PDFs per event | **~$0.01–0.05 / event** | Zero egress on R2; negligible |
| **Compute + managed Postgres** | Amortized platform cost | **~$0.05–0.15 / active event** | Fixed-ish, spread across events |

**Read this table and the strategy writes itself:** 100 LLM capture turns = $0.15. 100 SMS = $0.80. One document = the same as ~13 capture turns. The moment a contributor list gets long, SMS eats the budget.

---

## 2. Per-event lifecycle cost model

An "event" (wedding, funeral, kwanjula) is the natural unit: time-boxed, ~3–6 months of activity, then done. I modeled three sizes with realistic message and interaction volumes over the full lifecycle.

| | **Small** (≤50 contributors) | **Medium** (~150) | **Large** (~400) |
|---|---|---|---|
| Capture turns (total) | ~130 | ~400 | ~1,000 |
| ↳ LLM share (~60%) | 78 | 240 | 600 |
| Query turns | ~40 | ~80 | ~150 |
| Documents extracted | 3 | 5 | 8 |
| AI summaries/reports | 10 | 20 | 40 |
| **AI cost** | **~$0.29** | **~$0.68** | **~$1.49** |
| Confirmation SMS | ~110 | ~320 | ~850 |
| Reminder SMS | ~60 | ~240 | ~800 |
| Announcement SMS | ~100 | ~450 | ~1,600 |
| Total SMS | ~270 | ~1,010 | ~3,250 |
| **SMS cost** | **~$2.16** | **~$8.08** | **~$26.00** |
| Storage + amortized infra | ~$0.15 | ~$0.20 | ~$0.30 |
| **TOTAL COST / EVENT** | **~$2.60** | **~$8.96** | **~$27.79** |
| **SMS as % of cost** | **83%** | **90%** | **94%** |

The bigger the event, the *more* dominated by SMS it becomes — because contributors grow linearly but reminder/announcement fan-out grows with them. This is why contributor count and SMS allowance are the two dials we price on.

---

## 3. Pricing philosophy (the decisions)

**3.1 Primary SKU is per-event, not a subscription.** This is a deliberate reversal of the word "subscription" in the brief, and I'll defend it: a couple plans *one* wedding, then by definition churns. A monthly subscription for a one-off life event is a mismatch — it invites "subscribe, use for the wedding, cancel," which is just a clumsy, leaky per-event price with worse UX and worse collection (recurring mobile-money in Uganda is weak; see §8). **Per-event packs capture value at the moment of peak willingness-to-pay (the run-up to a big, expensive social event) with a single clean Mobile Money charge that MoMo handles perfectly.**

**3.2 Subscriptions exist, but for a different customer.** Event *planners*, churches with weekly programs, funeral-service providers, and SACCOs run many events continuously. For them a subscription is right. So we ship both — but the entitlement system (§7) is built so a plan can attach to **either an event scope or an account scope**, and neither is a special case.

**3.3 Give away AI; charge for reach, scale, and polish.** Free tier gets the full conversational magic at small scale. The upgrade triggers are the three things that cost us money or signal serious use: **more contributors, more SMS, and professional outputs** (un-watermarked reports, custom sender ID, committee seats).

**3.4 SMS is sold as metered credits, bundled + toppable, at a modest markup.** Because SMS is a near-zero-margin commodity that dominates cost, we do *not* bury unlimited SMS in a flat fee — that's how the margin dies on a 400-person event. Instead: each pack includes an SMS credit allowance sized to its tier; beyond that, users buy top-up credits. We pay ~UGX 30, sell credits at **UGX 45 (~$0.012)** — a ~50% markup that stays cheaper than every standalone bulk-SMS reseller, so it never feels like a rip-off, while turning our biggest cost line into a self-funding, usage-aligned revenue line.

---

## 4. Per-event packages (primary)

Prices in UGX with USD equivalents. "Included SMS" is a credit allowance; overage is bought as top-ups (§6). Margins use the §2 cost model.

| Plan | Price | Contributors | Included SMS | Key features | Est. cost to us | **Gross margin** |
|---|---|---|---|---|---|---|
| **Free** | UGX 0 | ≤25 | 30 credits | Full AI capture + dashboard, 1 budget doc, watermarked summary | ~$0.60 | — (acquisition) |
| **Starter** | **UGX 50,000** (~$13.50) | ≤100 | 300 credits | Everything, un-watermarked reports, reminders, 2 seats | ~$2.90 | **~$10.60 (78%)** |
| **Standard** | **UGX 120,000** (~$32.40) | ≤300 | 1,000 credits | + priority extraction, 5 seats, budget allocation views | ~$8.70 | **~$23.70 (73%)** |
| **Premium** | **UGX 250,000** (~$67.50) | ~1,000 (soft) | 3,000 credits | + custom sender ID, advanced reports, priority support, unlimited seats | ~$25.50 | **~$42.00 (62%)** |

Notes on the shape:
- **Margin compresses as events get bigger** (78% → 62%) precisely because SMS becomes a larger share. That's fine and intentional — top-up credits (sold at markup) claw margin back on the heaviest users, and big-event organizers have the highest willingness to pay (a UGX 80M wedding won't blink at UGX 250k).
- **Anchor is Starter.** It's the plan most weddings land on, and its 78% margin funds the free tier and the AI giveaway.
- Prices are **event-lifecycle** prices (one payment covers the ~6-month event), not monthly.

---

## 5. Subscription packages (recurring / organizational)

For customers who run events continuously. Pooled SMS allowance across all their events; billed monthly (card-on-file preferred; MoMo re-prompt fallback, §8).

| Plan | Price/mo | Active events | Pooled SMS/mo | For whom | Est. cost/mo | **Margin** |
|---|---|---|---|---|---|---|
| **Organizer Pro** | **UGX 100,000** (~$27) | up to 5 | 1,000 | Frequent organizers, small churches | ~$10 | **~$17 (63%)** |
| **Business** | **UGX 300,000** (~$81) | unlimited (fair-use) | 5,000 | Event planners, funeral providers, SACCOs, large churches | ~$45 | **~$36 (44%)** |
| **Business+ / API** | custom | unlimited | custom pooled | White-label sender ID, API access, multi-admin, cross-event analytics | variable | target ≥50% |

Subscriptions are a **Stage 3+ revenue line** in practice — we shouldn't chase them pre-PMF — but the metering system supports them from day one so we're not blocked when the first church or planner asks.

---

## 6. The SMS credits model (the margin engine)

This is the single most important thing to build correctly.

- **Credits are a decrementing balance** held per billing scope (event or account).
- **Included allowance** on each pack is granted as credits at purchase.
- **Top-ups** are sold in bundles at a markup that still undercuts standalone resellers:

| Top-up bundle | Price | Our cost | Margin | Effective price/SMS |
|---|---|---|---|---|
| 250 credits | UGX 12,000 (~$3.24) | ~$2.00 | ~38% | UGX 48 |
| 500 credits | UGX 22,000 (~$5.95) | ~$4.00 | ~33% | UGX 44 |
| 2,000 credits | UGX 80,000 (~$21.60) | ~$16.00 | ~26% | UGX 40 |

- **Reserve-then-commit** on every send: reserve credits in the same transaction as the outbox row; commit on delivery-receipt success; **refund the credit if the provider rejects the message** (so a failed SMS never costs the user a credit). This is what makes the ledger honest and prevents both overspend and user complaints.
- **Hard stop at zero** on outbound SMS, with graceful UX ("You're out of SMS credits — top up to send reminders"). Capture and AI keep working; only *reach* is gated. That's the right pressure point.

---

## 7. Metering, entitlements & billing — the architecture from day one

The blueprint's four bounded contexts gain a fifth **Billing & Entitlements** context. It is small but must exist from the first migration, because retrofitting metering after you have events in flight is painful and error-prone.

### 7.1 Core entities

```
billing_account         the payer; holds payment method + Flutterwave/Pesapal customer ref
plan                    catalog: price, scope_type(event|account), included allowances, feature flags
entitlement_grant       links a plan to a scope (an event OR an account); has status + period
                        status: trialing | active | past_due | expired | cancelled
entitlement (resolved)  the effective limits for a scope: max_contributors, features[], ...
sms_credit_ledger       APPEND-ONLY. +grants (purchase/topup), -reservations, -commits, +refunds
                        balance = SUM(entries).  This is the money-critical table.
usage_event             APPEND-ONLY meter log: {scope, kind(sms|llm_call|doc|storage),
                        quantity, unit_cost, tokens_in, tokens_out, model, ts}
invoice / payment       charges + settlement records from the payment gateway
```

### 7.2 Two enforcement gates, both pre-action, both deterministic

The blueprint already put a **permission** check (`can(actor, action, resource)`) before every mutating action. Billing adds a parallel **entitlement** check. Keep them separate — authorization answers *"are you allowed?"*, entitlement answers *"does your plan permit / can you afford it?"*.

```
request → auth → can(actor, action, resource)?        [role/permission]
                → within_entitlement(scope, action)?   [plan limits + credit balance]
                → domain service (transaction):
                       mutate + audit_event
                       + usage_event (meter)
                       + [if SMS] reserve credits in sms_credit_ledger
                       + outbox row
```

Concretely:
- **Adding contributor #101 on Starter** → `within_entitlement` sees `max_contributors=100`, blocks with an upgrade prompt.
- **Sending a reminder blast** → for each recipient, reserve 1 credit atomically; if balance would go negative, stop the blast at the boundary and tell the user how many they can still send / prompt a top-up. Never send SMS you can't pay for.
- **An LLM call** → *not* gated. It writes a `usage_event` for cost attribution and abuse monitoring, and proceeds. (Anomaly detection on `usage_event` catches a runaway/abusive account without ever cutting off a legitimate paying user mid-sentence.)

### 7.3 Why meter AI at all if we don't bill on it

Three reasons, all operational: (1) **per-event and per-account cost attribution** so we know our true margin and can spot a plan that's underpriced; (2) **abuse detection** (a free account generating 10k LLM calls is not planning a wedding); (3) **product analytics** (which intents/tools dominate, where the model escalates to the expensive tier). We build this cheaply because the blueprint already mandated AI-specific observability — `usage_event` *is* that table, doing double duty for cost and billing insight.

### 7.4 Idempotency & correctness (non-negotiable for a money table)

- The `sms_credit_ledger` is append-only; balance is derived, never mutated in place — same discipline as the audit trail, for the same reason (disputes).
- Every credit movement carries an idempotency key tied to the originating outbox row, so a retried send never double-charges.
- Grants (purchases) are applied inside the payment-webhook handler, idempotently keyed on the gateway transaction id, so a duplicated webhook can't double-credit.

---

## 8. Collecting the money (Uganda reality)

Charging our *own customers* for subscriptions is **not** custody of contribution funds — the "Akabbo never holds money" rule (blueprint §2.3) is about contributors' event money, and is untouched. Collecting our SaaS fee is normal and necessary.

- **Gateway: Flutterwave (primary), Pesapal (secondary/failover).** Both cover **MTN MoMo + Airtel Money + Visa/Mastercard** in Uganda with T+1 settlement. Integrate behind our own `PaymentProvider` interface (same abstraction discipline as SMS/LLM) so we can route or switch.
- **One-off event packs → single Mobile Money charge.** This is MoMo's sweet spot and why per-event pricing is operationally superior: the user approves one prompt on their phone, done.
- **Subscriptions → recurring is the weak spot in Uganda.** Native recurring mobile-money is unreliable; card tokenization works but card penetration is lower. Design: **card-on-file where available; otherwise a scheduled MoMo re-prompt** ("Your Akabbo Pro renews — approve UGX 100,000") plus dunning (grace period → `past_due` → soft-lock). This is another reason subscriptions are a Stage-3 concern, not a day-one focus — but the `billing_account` + `invoice` model supports it now.
- **Payment webhooks** are the source of truth for grants; the app never marks a plan active from the client. Idempotent handlers (§7.4).

---

## 9. Illustrative revenue picture

Not a forecast — a shape check, to confirm the model holds. Assume a month at early traction: 200 paid events + a handful of subscriptions.

| Line | Volume | Avg net revenue | Revenue | Our cost | Contribution |
|---|---|---|---|---|---|
| Starter events | 120 | UGX 50k | UGX 6.0M | ~UGX 1.3M | ~UGX 4.7M |
| Standard events | 60 | UGX 120k | UGX 7.2M | ~UGX 1.9M | ~UGX 5.3M |
| Premium events | 20 | UGX 250k | UGX 5.0M | ~UGX 1.9M | ~UGX 3.1M |
| SMS top-ups | — | — | ~UGX 3.0M | ~UGX 2.1M | ~UGX 0.9M |
| Organizer Pro subs | 10 | UGX 100k | UGX 1.0M | ~UGX 0.4M | ~UGX 0.6M |
| **Total** | | | **~UGX 22.2M** (~$6,000) | **~UGX 7.6M** | **~UGX 14.6M (~66%)** |

Blended contribution margin ~66%, with fixed costs (managed Postgres, hosting, Sentry, a bit of infra) on the order of **$100–300/mo at this stage** — trivially covered. The model is healthy *because* AI is cheap and SMS is sold at markup rather than absorbed. The risk to margin is a tier that bundles too much SMS into a flat fee; the credits model is the guardrail against exactly that.

---

## 10. Trials — design and cost exposure

**Decision: no time-boxed trial. Use a permanent free tier gated by volume + capability, plus a one-time "reach sampler."**

Reasoning: events run for months, so a 14-day clock is nonsensical — the user would still be collecting pledges when it expires. The right trial lets someone experience the *full product* at small scale and hit a natural wall exactly where we add cost/value.

**Free tier as the trial:**
- 1 active event, **≤25 contributors**, full AI capture + dashboard, 1 document extraction, watermarked summary.
- **30 SMS credits, once** — enough to feel the confirmation/reminder loop (which is what sells it), not enough to run a real 200-person campaign for free.
- Upgrade triggers hit naturally: contributor #26, the 31st SMS, the un-watermarked report, the second event.

**Cost exposure of the free tier / trial:** the only real money-leak vector is SMS (AI on a free event costs us **~$0.30 total** — we simply don't care). So the trial's cost is *capped by construction* at **~$1** per free event (30 SMS ≈ $0.24 + AI ≈ $0.30 + infra). Even 10,000 free events = ~$10k max exposure, and each free event is a viral surface (25 contributors each get an Akabbo SMS).

**Abuse mitigations (all cheap, all in the entitlement layer):**
- **Phone-verified accounts; one free event's SMS allowance per verified number.** Kills the "spin up free events to blast SMS" attack — the only attack that costs us.
- No bulk *announcement* SMS on free tier (only per-contribution confirmations + a tiny reminder quota), so free SMS can't be repurposed as a marketing blaster.
- Global rate limits on the SMS-send path (already mandated in blueprint §10 as a financial-loss vector).
- AI is generous on free tier *because it's safe to be* — `usage_event` anomaly detection flags the rare abuser without punishing the 99%.

**Optional paid-conversion nudge — the "reach sampler":** when a free user hits the 25-contributor wall or their 30 SMS, offer a one-tap top-up (250 credits, UGX 12k) *without* forcing a full plan purchase. Lowers the activation barrier from "commit UGX 50k" to "spend UGX 12k to finish this reminder," then upsell the full pack. This maps directly onto the credits model — no special-case code.

---

## 11. Decisions made (so the build can start)

1. **Per-event packs are the primary SKU; subscriptions are secondary/organizational.** Both supported by one scope-agnostic entitlement model.
2. **Sell reach + scale + polish; give away AI.** AI is unmetered-for-billing on all paid tiers, generous on free.
3. **SMS = decrementing credits**, reserve-then-commit, refund-on-failure, hard-stop at zero, sold at ~50% markup and toppable.
4. **Four per-event tiers** (Free / 50k / 120k / 250k) and **two-to-three subscription tiers** (Pro 100k/mo, Business 300k/mo, custom).
5. **Trial = permanent volume-gated free tier**, ≤25 contributors + 30 one-time SMS, phone-verified, ~$1 max cost exposure per free event.
6. **Billing & Entitlements is a first-class bounded context** with two pre-action gates (permission + entitlement), append-only credit ledger, dual-purpose `usage_event` meter.
7. **Flutterwave primary / Pesapal secondary**, behind a `PaymentProvider` interface; one-shot MoMo for event packs, card-on-file/re-prompt for subs; webhooks are the source of truth for grants.

## 12. Open questions that would tune the numbers

1. **Real contributor-count and SMS-frequency distribution** — my lifecycle model is estimated. First 20 real events will let us re-tune allowances and tier boundaries. The *architecture* doesn't change; the *numbers in the plan table* will.
2. **Willingness-to-pay ceiling** — is UGX 250k premium too low for a UGX 80M wedding? I suspect we can charge more at the top; needs testing.
3. **Do we let contributors self-confirm via inbound SMS/USSD?** That would cut confirmation-SMS volume (our top cost) dramatically and improve data integrity — ties directly to the SMS-ingestion wedge in blueprint §2.2. Potentially margin-transformative.
4. **Currency of pricing** — pin prices in UGX (recommended, market-legible) and treat USD as reporting only, given FX drift.
5. **Refund/dispute policy** on event packs (event cancelled, family disputes) — a policy decision with light system support (partial credit refund to `sms_credit_ledger` is already possible).

---

## Sources

- [Flutterwave Uganda pricing](https://flutterwave.com/ug/pricing/) · [Flutterwave Uganda mobile money (dev)](https://developer.flutterwave.com/v2.0/reference/uganda-mobile-money) · [Pesapal Uganda](https://www.pesapal.com/ug) · [Best payment gateways for Uganda e-commerce](https://www.desishub.com/blog/best-payment-gateways-for-ecommerce-sites-in-uganda)
- [UGX/USD rate, July 2026](https://www.exchange-rates.org/converter/ugx-usd) · [Trading Economics — UGX](https://tradingeconomics.com/uganda/currency)
- SMS & LLM cost inputs carried from the blueprint: [Africa's Talking pricing](https://africastalking.com/pricing), [EgoSMS Uganda pricing](https://egosms.co/pricing.php), [LLM pricing July 2026](https://benchlm.ai/llm-pricing), [Gemini Flash vs mini vs Haiku](https://macaron.im/blog/gemini-flash-lite-vs-gpt4o-mini-vs-claude-haiku).
