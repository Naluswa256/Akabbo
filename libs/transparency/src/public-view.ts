import {
  BudgetVisibility,
  ContributorVisibility,
  EventStatus,
  FulfillmentKind,
  PaymentMethod,
  PledgeType,
} from '@prisma/client';

/**
 * The PUBLIC EVENT PROJECTION (transparency spec Part 11).
 *
 * This is the ONLY shape the unauthenticated public surface ever returns. It is
 * a DELIBERATE selection — it must never carry `person.id`, phone numbers,
 * `fulfillment.note`, audit rows, AI history, internal UUIDs, or billing data
 * (Part 10). Every field here is safe to show anyone with the link.
 *
 * All money is a decimal-free integer-minor-units STRING (never a JS number).
 */

export type ContributorStatus = 'FULLY_PAID' | 'PARTIALLY_PAID' | 'PLEDGED';
export type BudgetItemStatus = 'FUNDED' | 'PARTIALLY_FUNDED' | 'UNFUNDED';

/** One payment/split entry within a pledge — "pledge 1M, then below it, the
 *  entries of payments made against it." */
export interface PublicPledgePayment {
  value: string;
  kind: FulfillmentKind;
  /** ISO-8601. */
  occurredAt: string;
}

/** A single pledge and its payment history. A contributor can have more than
 *  one pledge (e.g. pledged again later) — each is its own entry. */
export interface PublicPledgeEntry {
  type: PledgeType;
  committedValue: string;
  /** In-kind detail ("2 goats") — set only for ITEM/SERVICE. */
  description: string | null;
  status: ContributorStatus;
  /** Omitted (undefined) when the organizer has hidden outstanding figures. */
  outstanding?: string;
  payments: PublicPledgePayment[];
}

export interface PublicContributor {
  displayName: string;
  /** Amounts are omitted when visibility is NAMES_ONLY. */
  committed?: string;
  received?: string;
  outstanding?: string;
  status?: ContributorStatus;
  /** Per-pledge breakdown with payment entries — same visibility tier as
   *  committed/received (NAMES_AND_AMOUNTS). Omitted otherwise. */
  pledges?: PublicPledgeEntry[];
}

export interface PublicBudgetItem {
  name: string;
  target: string;
  covered: string;
  remaining: string;
  status: BudgetItemStatus;
}

export interface PublicBudget {
  total: string;
  covered: string;
  remaining: string;
  items: PublicBudgetItem[];
}

export interface PublicActivityEntry {
  displayName: string;
  value: string;
  /** ISO-8601. */
  occurredAt: string;
}

export interface PublicAnnouncement {
  body: string;
  /** ISO-8601. */
  publishedAt: string;
}

export interface PublicPaymentInstruction {
  method: PaymentMethod;
  label: string;
  details: string;
}

export interface PublicEventView {
  slug: string;
  name: string;
  description: string | null;
  /** ISO-8601 date or null. */
  eventDate: string | null;
  status: EventStatus;
  currency: string;

  // ── Financial totals — computed in ONE transaction so they never contradict
  //    each other (Part 28). target/remaining/percentCovered are null when the
  //    organizer has turned showTarget off; totalOutstanding is null when
  //    showOutstanding is off. totalPledged/totalReceived are always present. ─
  target: string | null;
  totalPledged: string;
  totalReceived: string;
  totalOutstanding: string | null;
  /** target − received, or null when no target is set OR showTarget is off. */
  remaining: string | null;
  percentCovered: number | null;

  // ── Config-gated detail. ────────────────────────────────────────────────────
  /** Number of people who committed anything; null when contributors HIDDEN. */
  contributorCount: number | null;
  /** null when the budget is HIDDEN. */
  budget: PublicBudget | null;
  /** null when visibility is AGGREGATE_ONLY or HIDDEN. */
  contributors: PublicContributor[] | null;
  /** Recent received contributions; only shown at NAMES_AND_AMOUNTS. */
  recentActivity: PublicActivityEntry[] | null;

  announcements: PublicAnnouncement[];
  paymentInstructions: PublicPaymentInstruction[];

  /** Monotonic marker for cache/ETag invalidation (Part 12). */
  revision: number;

  /** Echoes the applied config so a client knows why a section is absent. */
  visibility: {
    contributors: ContributorVisibility;
    budget: BudgetVisibility;
    showTarget: boolean;
    showOutstanding: boolean;
  };
}
