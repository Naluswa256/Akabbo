/**
 * SINGLE CONFIGURABLE PLACE FOR ALL PLAN ENTITLEMENT LIMITS AND BUNDLED CREDITS.
 *
 * Uganda-First Pricing Strategy:
 * Lower impulse-price thresholds (UGX 10k / 30k / 60k) designed for mass adoption
 * and behavioral change replacing WhatsApp chaos.
 *
 * SMS PRICING RULE (enforced here, not in code):
 *   includedSmsCredits × UGX 35 (UGSMS cost) must be ≤ 35% of priceMinor.
 *   This ensures SMS COGS never exceeds 35% of revenue even at 100% utilisation,
 *   leaving ≥65% to cover AI costs and infrastructure. See comments per plan.
 *   Additional SMS is available via SMS_TOP_UP_100 / SMS_TOP_UP_300 packs (42–34%
 *   gross margin), converting the credit wall into a profitable upsell channel.
 */

export interface PlanConfig {
  code: string;
  name: string;
  scope: 'EVENT' | 'ACCOUNT';
  priceMinor: bigint;
  currency: string;
  maxContributors: number | null;
  includedSmsCredits: number;
  includedAiCredits: number;
  features: string[];
  isSubscription: boolean;
}

export const PLAN_CATALOG: Record<string, PlanConfig> = {
  FREE: {
    code: 'FREE',
    name: 'Free Trial',
    scope: 'EVENT',
    priceMinor: 0n,
    currency: 'UGX',
    maxContributors: 15,
    // Tighter Free Trial (2026-07-30): 10 SMS + 15 AI turns. Costs ~UGX 500 ($0.13)
    // per signup instead of UGX 1,800 ($0.48). Enough to test 1-2 broadcasts and
    // see the AI work, but forces any real 20+ person event to upgrade to STARTER.
    includedSmsCredits: 10,
    includedAiCredits: 15,
    features: ['basic_analytics'],
    isSubscription: false,
  },
  STARTER: {
    code: 'STARTER',
    name: 'Starter Pack',
    scope: 'EVENT',
    priceMinor: 10_000n,
    currency: 'UGX',
    maxContributors: 100,
    // SMS fix (2026-07-30): was 300. At UGSMS rate of UGX 35/SMS, 300 SMS costs
    // UGX 10,500 — MORE than the pack price of UGX 10,000. Reduced to 100 SMS
    // (max cost UGX 3,500 = 35% of revenue), leaving 65% to cover AI + profit.
    // Users who need more SMS purchase a top-up pack (SMS_TOP_UP_100/300 below).
    includedSmsCredits: 100,
    includedAiCredits: 500,
    features: ['unwatermarked_reports', 'seats_3'],
    isSubscription: false,
  },
  STANDARD: {
    code: 'STANDARD',
    name: 'Standard Pack',
    scope: 'EVENT',
    priceMinor: 30_000n,
    currency: 'UGX',
    maxContributors: 300,
    // SMS fix (2026-07-30): was 1,000. At UGSMS UGX 35/SMS, 1,000 SMS = UGX 35,000
    // — exceeds the UGX 30,000 pack price. Reduced to 300 SMS (max cost UGX 10,500
    // = 35% of revenue), leaving 65% to cover AI + profit.
    includedSmsCredits: 300,
    includedAiCredits: 1500,
    features: ['unwatermarked_reports', 'seats_10', 'custom_branding'],
    isSubscription: false,
  },
  PREMIUM: {
    code: 'PREMIUM',
    name: 'Premium Pack',
    scope: 'EVENT',
    priceMinor: 60_000n,
    currency: 'UGX',
    maxContributors: 1000,
    // SMS fix (2026-07-30): was 3,000. At UGSMS UGX 35/SMS, 3,000 SMS = UGX 105,000
    // — nearly 2× the pack price. Reduced to 600 SMS (max cost UGX 21,000 = 35%
    // of revenue). High-volume organizers purchase SMS top-ups as needed.
    includedSmsCredits: 600,
    includedAiCredits: 5000,
    features: ['unwatermarked_reports', 'unlimited_seats', 'custom_branding', 'priority_support'],
    isSubscription: false,
  },
  ORGANIZER_PRO: {
    code: 'ORGANIZER_PRO',
    name: 'Organizer Pro Subscription',
    scope: 'ACCOUNT',
    priceMinor: 30_000n,
    currency: 'UGX',
    maxContributors: 500,
    // SMS fix (2026-07-30): was 2,000. At UGX 35/SMS, 2,000 SMS = UGX 70,000/mo
    // — more than 2× the UGX 30,000/mo subscription. Reduced to 300 SMS/mo
    // (max cost UGX 10,500 = 35% of revenue). Additional SMS via top-up packs.
    includedSmsCredits: 300,
    includedAiCredits: 3000,
    features: ['unwatermarked_reports', 'seats_5'],
    isSubscription: true,
  },
  BUSINESS: {
    code: 'BUSINESS',
    name: 'Business Subscription',
    scope: 'ACCOUNT',
    priceMinor: 120_000n,
    currency: 'UGX',
    maxContributors: null,
    // SMS fix (2026-07-30): was 5,000. At UGX 35/SMS, 5,000 SMS = UGX 175,000/mo
    // — exceeds the UGX 120,000/mo subscription. Reduced to 1,000 SMS/mo
    // (max cost UGX 35,000 = 29% of revenue). High-volume accounts buy top-ups.
    includedSmsCredits: 1000,
    includedAiCredits: 10000,
    features: ['unwatermarked_reports', 'unlimited_seats', 'custom_branding', 'dedicated_account_manager'],
    isSubscription: true,
  },

  // ── SMS Top-Up Packs ───────────────────────────────────────────────────────
  // EVENT-scoped so purchaseEventPack() applies them directly to any active
  // event. No new billing code required — the webhook handler already grants
  // includedSmsCredits from any paid plan. These turn the "out of SMS" wall
  // into a profitable upsell: UGX 60/SMS charged vs UGX 35/SMS cost = 42% margin.
  SMS_TOP_UP_100: {
    code: 'SMS_TOP_UP_100',
    name: 'SMS Top-Up — 100 messages',
    scope: 'EVENT',
    priceMinor: 6_000n, // UGX 6,000 · UGX 60/SMS · cost UGX 35/SMS · margin 42%
    currency: 'UGX',
    maxContributors: null,
    includedSmsCredits: 100,
    includedAiCredits: 0,
    features: [],
    isSubscription: false,
  },
  SMS_TOP_UP_300: {
    code: 'SMS_TOP_UP_300',
    name: 'SMS Top-Up — 300 messages',
    scope: 'EVENT',
    priceMinor: 16_000n, // UGX 16,000 · UGX 53/SMS · slight bulk discount · margin 34%
    currency: 'UGX',
    maxContributors: null,
    includedSmsCredits: 300,
    includedAiCredits: 0,
    features: [],
    isSubscription: false,
  },
};
