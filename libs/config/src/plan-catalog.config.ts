/**
 * SINGLE CONFIGURABLE PLACE FOR ALL PLAN ENTITLEMENT LIMITS AND BUNDLED CREDITS.
 *
 * Uganda-First Pricing Strategy:
 * Lower impulse-price thresholds (UGX 10k / 30k / 60k) designed for mass adoption
 * and behavioral change replacing WhatsApp chaos.
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
    maxContributors: 25,
    includedSmsCredits: 30,
    includedAiCredits: 50,
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
    includedSmsCredits: 300,
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
    includedSmsCredits: 1000,
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
    includedSmsCredits: 3000,
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
    includedSmsCredits: 2000,
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
    includedSmsCredits: 5000,
    includedAiCredits: 10000,
    features: ['unwatermarked_reports', 'unlimited_seats', 'custom_branding', 'dedicated_account_manager'],
    isSubscription: true,
  },
};
