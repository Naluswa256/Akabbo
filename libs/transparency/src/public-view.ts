import {
  BudgetVisibility,
  ContributorVisibility,
  EventStatus,
  PaymentMethod,
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

export interface PublicContributor {
  displayName: string;
  /** Amounts are omitted when visibility is NAMES_ONLY. */
  committed?: string;
  received?: string;
  outstanding?: string;
  status?: ContributorStatus;
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

  // ── Financial totals — ALWAYS present when the event is public (Part 3). ────
  /** These five never contradict: computed in ONE transaction (Part 28). */
  target: string | null;
  totalPledged: string;
  totalReceived: string;
  totalOutstanding: string;
  /** target − received, or null when no target is set. */
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
  };
}
