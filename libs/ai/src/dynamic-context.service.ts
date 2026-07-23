import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@akabbo/prisma';

@Injectable()
export class DynamicContextService {
  private readonly logger = new Logger(DynamicContextService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Query approved learned exemplars and phrasing rules matching the user prompt,
   * and format them as concise system prompt guidance.
   */
  async getRelevantContext(userPrompt: string): Promise<string> {
    try {
      const activeExemplars = await this.prisma.aiLearnedExemplar.findMany({
        where: { status: 'APPROVED' },
        orderBy: { confidenceScore: 'desc' },
        take: 20,
      });

      if (activeExemplars.length === 0) return '';

      const normalizedPrompt = userPrompt.toLowerCase();
      const tokens = new Set(normalizedPrompt.split(/\W+/).filter((t) => t.length > 2));

      // Score matching exemplars
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

  /** Seed an initial curated domain exemplar into the database if empty. */
  async seedInitialExemplars(): Promise<void> {
    const count = await this.prisma.aiLearnedExemplar.count();
    if (count > 0) return;

    await this.prisma.aiLearnedExemplar.createMany({
      data: [
        {
          category: 'KWANJULA_BUDGET',
          triggerKeywords: ['kwanjula', 'amakanzu', 'omutwalo', 'ebibo', 'amajani'],
          userPromptPattern: 'Extract budget items for Kwanjula',
          learnedGuidance:
            'When users upload or mention Kwanjula items (Amakanzu, Omutwalo, Ebibo, Amajani), group them under Cultural Introduction Budget items.',
          confidenceScore: 1.0,
          status: 'APPROVED',
        },
        {
          category: 'PAYMENT_CORRECTION',
          triggerKeywords: ['correct', 'wrong', 'mistake', 'payment', 'pledge'],
          userPromptPattern: 'Correct payment amount for contributor',
          learnedGuidance:
            'When a user asks to correct a payment or pledge, use `correct_payment` or `correct_pledge` and stage for explicit confirmation.',
          confidenceScore: 1.0,
          status: 'APPROVED',
        },
        {
          category: 'ROLE_EXPLANATION',
          triggerKeywords: ['invite', 'role', 'permission', 'coordinator', 'finance'],
          userPromptPattern: 'Attempting restricted role action',
          learnedGuidance:
            'Always explain what the user CAN do based on their assigned role before stating restricted capabilities.',
          confidenceScore: 1.0,
          status: 'APPROVED',
        },
      ],
    });
  }
}
