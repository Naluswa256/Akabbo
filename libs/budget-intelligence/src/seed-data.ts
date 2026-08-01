import {
  BudgetKnowledgeExtractionMethod,
  BudgetKnowledgeReliability,
  BudgetKnowledgeSourceType,
  BudgetTier,
} from '@prisma/client';
import { KnowledgeObservationInput, KnowledgeSourceInput } from './budget-knowledge.service';

/**
 * The v1 starter floor — real numbers read from two freely-published,
 * search-indexed Ugandan wedding-cost articles during the architecture
 * research for this feature (never Scribd — see domain-blocklist.ts and the
 * exploration doc §4 for why). Every figure here is one this session
 * actually verified via a real fetch of the source, not invented to fill
 * the table: where a source gave a qualitative note ("upgraded decor") with
 * no number attached, it's recorded as a commonlyForgotten pattern row with
 * no price, never a guessed range.
 *
 * These two sources happen to disagree on total cost for a comparable
 * scope — left as two rows rather than reconciled into one, since that
 * disagreement is real and is exactly what BudgetKnowledgeObservation's
 * multi-source confidence model exists to hold honestly (see
 * getRecommendation's confidenceLabel: a single source never reads as
 * HIGH).
 */
export const SEED_DATA: { source: KnowledgeSourceInput; observations: KnowledgeObservationInput[] }[] = [
  {
    source: {
      sourceType: BudgetKnowledgeSourceType.public_article,
      name: 'Harusi Hub — How Much Does a Wedding Cost in Uganda? (2026 Guide)',
      url: 'https://blog.harusihub.com/post/wedding-cost-uganda/',
      reliability: BudgetKnowledgeReliability.MEDIUM,
      licensingNote:
        'Publicly published marketing/guidance blog content, indexed for search and intended to be read and shared — not user-uploaded content of uncertain rights-holder status. Manually reviewed before entry.',
      extractionMethod: BudgetKnowledgeExtractionMethod.manual,
    },
    observations: [
      {
        eventType: 'wedding',
        category: 'Total (kwanjula + church wedding, budget tier)',
        tier: BudgetTier.budget,
        amountMin: 12_000_000n,
        amountMax: 15_000_000n,
        confidence: 0.6,
        observedAt: new Date('2026-01-01'),
      },
      {
        eventType: 'wedding',
        category: 'Total (kwanjula + church wedding, mid-range tier)',
        tier: BudgetTier.mid,
        amountMin: 38_000_000n,
        amountMax: 42_000_000n,
        confidence: 0.6,
        observedAt: new Date('2026-01-01'),
      },
      {
        eventType: 'wedding',
        category: 'Total (kwanjula + church wedding, premium tier)',
        tier: BudgetTier.premium,
        amountMin: 94_000_000n,
        amountMax: 104_000_000n,
        confidence: 0.6,
        observedAt: new Date('2026-01-01'),
      },
      {
        eventType: 'wedding',
        category: 'Catering',
        tier: BudgetTier.budget,
        unit: 'per plate',
        amountMin: 15_000n,
        amountMax: 25_000n,
        confidence: 0.65,
        observedAt: new Date('2026-01-01'),
      },
      {
        eventType: 'wedding',
        category: 'Catering',
        tier: BudgetTier.premium,
        unit: 'per plate',
        amountMin: 50_000n,
        amountMax: 100_000n,
        confidence: 0.65,
        observedAt: new Date('2026-01-01'),
      },
      {
        eventType: 'kwanjula',
        category: 'Delegation attire',
        commonlyForgotten: true,
        confidence: 0.5,
        observedAt: new Date('2026-01-01'),
      },
      {
        eventType: 'wedding',
        category: 'Multiple outfit changes',
        commonlyForgotten: true,
        confidence: 0.5,
        observedAt: new Date('2026-01-01'),
      },
      {
        eventType: 'wedding',
        category: 'Day-of tips',
        commonlyForgotten: true,
        confidence: 0.5,
        observedAt: new Date('2026-01-01'),
      },
      {
        eventType: 'wedding',
        category: 'Parking and security',
        commonlyForgotten: true,
        confidence: 0.5,
        observedAt: new Date('2026-01-01'),
      },
      {
        eventType: 'wedding',
        category: 'Post-wedding photography products',
        commonlyForgotten: true,
        confidence: 0.5,
        observedAt: new Date('2026-01-01'),
      },
      {
        eventType: 'wedding',
        category: 'Regional adjustment',
        item: 'Mbarara, Jinja, Gulu and other regional towns run roughly 20-40% lower than Kampala',
        commonlyForgotten: false,
        confidence: 0.5,
        observedAt: new Date('2026-01-01'),
      },
    ],
  },
  {
    source: {
      sourceType: BudgetKnowledgeSourceType.public_article,
      name: 'Palm Gardens — Wedding Budget in Uganda (5M/10M/15M/25M/50M+)',
      url: 'https://palmgardensug.com/wedding-budget-in-uganda/',
      reliability: BudgetKnowledgeReliability.MEDIUM,
      licensingNote:
        'Publicly published marketing/guidance blog content, indexed for search and intended to be read and shared — not user-uploaded content of uncertain rights-holder status. Manually reviewed before entry.',
      extractionMethod: BudgetKnowledgeExtractionMethod.manual,
    },
    observations: [
      {
        eventType: 'wedding',
        category: 'Food/catering',
        tier: BudgetTier.budget,
        amountMin: 2_000_000n,
        amountMax: 2_000_000n,
        confidence: 0.55,
        observedAt: new Date('2026-04-24'),
      },
      {
        eventType: 'wedding',
        category: 'Food/catering',
        tier: BudgetTier.mid,
        amountMin: 3_000_000n,
        amountMax: 4_000_000n,
        confidence: 0.6,
        observedAt: new Date('2026-04-24'),
      },
      {
        eventType: 'wedding',
        category: 'Full buffet',
        unit: 'per person',
        amountMin: 28_000n,
        amountMax: 28_000n,
        confidence: 0.55,
        observedAt: new Date('2026-04-24'),
      },
      {
        eventType: 'wedding',
        category: 'Venue requiring expensive setup',
        commonlyForgotten: true,
        confidence: 0.5,
        observedAt: new Date('2026-04-24'),
      },
      {
        eventType: 'wedding',
        category: 'Underestimating food costs',
        commonlyForgotten: true,
        confidence: 0.5,
        observedAt: new Date('2026-04-24'),
      },
      {
        eventType: 'wedding',
        category: 'Decor spend vs guest experience tradeoff',
        commonlyForgotten: true,
        confidence: 0.5,
        observedAt: new Date('2026-04-24'),
      },
      {
        eventType: 'wedding',
        category: 'Logistics and coordination',
        commonlyForgotten: true,
        confidence: 0.5,
        observedAt: new Date('2026-04-24'),
      },
    ],
  },
];
