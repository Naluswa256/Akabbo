import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@akabbo/prisma';

interface CachedAddenda {
  expiresAt: number;
  exemplars: Array<{ category: string; triggerKeywords: string[]; learnedGuidance: string }>;
}

@Injectable()
export class DynamicContextService {
  private readonly logger = new Logger(DynamicContextService.name);
  private cache: CachedAddenda | null = null;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute compiled cache bound

  constructor(private readonly prisma: PrismaService) {}

  /** Clear in-memory prompt addenda cache (e.g. after approval changes). */
  clearCache(): void {
    this.cache = null;
  }

  /**
   * Query strictly APPROVED learned exemplars matching the user prompt,
   * using an in-memory cache to guarantee zero DB latency overhead per turn.
   */
  async getRelevantContext(userPrompt: string): Promise<string> {
    try {
      const now = Date.now();
      if (!this.cache || this.cache.expiresAt < now) {
        const approved = await this.prisma.aiLearnedExemplar.findMany({
          where: { status: 'APPROVED' },
          orderBy: { confidenceScore: 'desc' },
          select: { category: true, triggerKeywords: true, learnedGuidance: true },
          take: 20,
        });
        this.cache = { expiresAt: now + this.CACHE_TTL_MS, exemplars: approved };
      }

      const activeExemplars = this.cache.exemplars;
      if (activeExemplars.length === 0) return '';

      const normalizedPrompt = userPrompt.toLowerCase();
      const tokens = new Set(normalizedPrompt.split(/\W+/).filter((t) => t.length > 2));

      // Filter matching exemplars
      const matched = activeExemplars.filter((ex) => {
        if (!ex.triggerKeywords || ex.triggerKeywords.length === 0) return true;
        return ex.triggerKeywords.some(
          (kw) => normalizedPrompt.includes(kw.toLowerCase()) || tokens.has(kw.toLowerCase()),
        );
      });

      const topExemplars = (matched.length > 0 ? matched : activeExemplars).slice(0, 5);

      if (topExemplars.length === 0) return '';

      const lines = [
        '============================================================',
        'LEARNED DOMAIN KNOWLEDGE & EXEMPLARY PATTERNS (SELF-LEARNING)',
        '============================================================',
        'These dynamic guidance patterns were derived from observed successful interactions:',
        '',
      ];

      for (const ex of topExemplars) {
        lines.push(`• [${ex.category}] ${ex.learnedGuidance}`);
      }

      return lines.join('\n');
    } catch (err) {
      this.logger.warn(`Failed to retrieve dynamic learned context: ${err instanceof Error ? err.message : String(err)}`);
      return '';
    }
  }

  /** Seed curated Ugandan cold-start domain exemplars as pre-APPROVED on launch. */
  async seedInitialExemplars(): Promise<void> {
    const count = await this.prisma.aiLearnedExemplar.count();
    if (count > 0) return;

    await this.prisma.aiLearnedExemplar.createMany({
      data: [
        {
          category: 'KWANJULA_CULTURAL_GIFTS',
          triggerKeywords: ['kwanjula', 'amakanzu', 'omutwalo', 'ebibo', 'amajani', 'mutwalo'],
          userPromptPattern: 'Extract budget items for Kwanjula',
          learnedGuidance:
            'When users upload or mention Kwanjula items (Amakanzu, Omutwalo, Ebibo, Amajani), group them under Cultural Introduction Budget items.',
          confidenceScore: 1.0,
          occurrenceCount: 5,
          status: 'APPROVED',
        },
        {
          category: 'FUNERAL_MABEGO_RAISING',
          triggerKeywords: ['funeral', 'burial', 'mabego', 'condolence', 'vigil'],
          userPromptPattern: 'Funeral / Mabego contribution tracking',
          learnedGuidance:
            'For funeral (Mabego) events, prioritize rapid contribution recording and generate public transparency dashboard links.',
          confidenceScore: 1.0,
          occurrenceCount: 5,
          status: 'APPROVED',
        },
        {
          category: 'MOMO_SCREENSHOT_RECEIPT',
          triggerKeywords: ['momo', 'screenshot', 'mobile money', 'mtn', 'airtel', 'receipt'],
          userPromptPattern: 'Extract Mobile Money contribution screenshot',
          learnedGuidance:
            'When a Mobile Money receipt/screenshot is uploaded, extract the sender name, transaction ID, and amount, then stage for confirmation.',
          confidenceScore: 1.0,
          occurrenceCount: 5,
          status: 'APPROVED',
        },
        {
          category: 'PAYMENT_CORRECTION',
          triggerKeywords: ['correct', 'wrong', 'mistake', 'payment', 'pledge'],
          userPromptPattern: 'Correct payment amount for contributor',
          learnedGuidance:
            'When a user asks to correct a payment or pledge, use `correct_payment` or `correct_pledge` and stage for explicit confirmation.',
          confidenceScore: 1.0,
          occurrenceCount: 5,
          status: 'APPROVED',
        },
        {
          category: 'ROLE_EXPLANATION',
          triggerKeywords: ['invite', 'role', 'permission', 'coordinator', 'finance'],
          userPromptPattern: 'Attempting restricted role action',
          learnedGuidance:
            'Always explain what the user CAN do based on their assigned role before stating restricted capabilities.',
          confidenceScore: 1.0,
          occurrenceCount: 5,
          status: 'APPROVED',
        },
      ],
    });
  }
}
