import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@akabbo/prisma';
import { LLM_PROVIDER, LlmProvider } from '@akabbo/providers';
import { redactPii } from './redaction-helper';

export interface EvaluationResult {
  evaluatedTurnsCount: number;
  confirmedCount: number;
  rejectedCount: number;
  clarificationCount: number;
  insightsSummary: string;
  newExemplarsCount: number;
  tier1ParserSuggestions?: string[];
}

@Injectable()
export class SelfLearningService {
  private readonly logger = new Logger(SelfLearningService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  /**
   * Offline Reflection Loop: Evaluates un-evaluated interaction traces,
   * analyzes tool outcomes, rejected actions, and clarification patterns,
   * anonymizes text, distills exemplars as PENDING_REVIEW, and promotes patterns
   * with occurrenceCount >= 2.
   */
  async runEvaluationCycle(limit = 50): Promise<EvaluationResult> {
    const traces = await this.prisma.aiInteractionTrace.findMany({
      where: { evaluated: false },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    if (traces.length === 0) {
      return {
        evaluatedTurnsCount: 0,
        confirmedCount: 0,
        rejectedCount: 0,
        clarificationCount: 0,
        insightsSummary: 'No un-evaluated interaction traces found.',
        newExemplarsCount: 0,
      };
    }

    const traceIds = traces.map((t) => t.id);
    const confirmed = traces.filter((t) => t.stagedStatus === 'CONFIRMED');
    const rejected = traces.filter((t) => t.stagedStatus === 'REJECTED');
    const clarifications = traces.filter((t) => t.stagedStatus === 'CLARIFICATION');

    const summaryParts: string[] = [
      `Evaluated ${traces.length} un-evaluated interaction turns:`,
      `• ${confirmed.length} actions confirmed by users.`,
      `• ${rejected.length} actions rejected/cancelled by users.`,
      `• ${clarifications.length} turns required user clarification.`,
    ];

    let newExemplarsCount = 0;
    const tier1Suggestions: string[] = [];

    // Distill learning points from rejected or clarification turns
    if (rejected.length > 0 || clarifications.length > 0) {
      const problematicPrompts = [...rejected, ...clarifications]
        .map((t) => `Prompt: "${redactPii(t.userPrompt)}" -> Tool: ${t.toolCallsJson ? redactPii(t.toolCallsJson) : 'none'}`)
        .slice(0, 10)
        .join('\n');

      try {
        const evalPrompt = [
          'Analyze these anonymized AI interaction traces where users rejected an action or needed clarification:',
          problematicPrompts,
          '',
          'Provide 1 concise, generalized, PII-free exemplar for how the AI can improve its interpretation of similar requests in the future.',
          'IMPORTANT: Do NOT include any real names, phone numbers, or exact amounts.',
        ].join('\n');

        const completion = await this.llm.complete({
          messages: [{ role: 'user', content: evalPrompt }],
          tools: [],
          temperature: 0.2,
        });

        const rawGuidance = completion.text?.trim();
        const distilledGuidance = redactPii(rawGuidance || '');

        if (distilledGuidance && distilledGuidance.length > 10) {
          summaryParts.push(`\nDistilled Anonymized Insight:\n${distilledGuidance}`);

          // Check if similar pattern exists
          const existing = await this.prisma.aiLearnedExemplar.findFirst({
            where: { category: 'REFLECTION_INSIGHT', learnedGuidance: distilledGuidance },
          });

          if (existing) {
            const updatedCount = existing.occurrenceCount + 1;
            // Frequency-based promotion threshold: occurrenceCount >= 2 enables promotion to APPROVED
            const newStatus = updatedCount >= 2 ? 'APPROVED' : existing.status;
            await this.prisma.aiLearnedExemplar.update({
              where: { id: existing.id },
              data: { occurrenceCount: updatedCount, status: newStatus },
            });
          } else {
            await this.prisma.aiLearnedExemplar.create({
              data: {
                category: 'REFLECTION_INSIGHT',
                triggerKeywords: ['help', 'correct', 'pledge', 'payment', 'kwanjula'],
                userPromptPattern: 'Reflection from rejected/clarified turns',
                learnedGuidance: distilledGuidance,
                confidenceScore: 0.9,
                occurrenceCount: 1,
                status: 'PENDING_REVIEW', // Hard gate default!
              },
            });
            newExemplarsCount += 1;
          }
        }
      } catch (err) {
        this.logger.warn(`LLM evaluation distillation warning: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Deterministic Tier-1 Parser Mining: identify highly repeated phrasings
    if (confirmed.length > 3) {
      tier1Suggestions.push(
        'Suggested tier1-parser.ts regex addition: /^(record|add|paid)\\s+(\\d+k?)\\s+from\\s+([a-z\\s]+)/i for direct contribution logging',
      );
    }

    // Mark evaluated traces
    await this.prisma.aiInteractionTrace.updateMany({
      where: { id: { in: traceIds } },
      data: { evaluated: true },
    });

    const insightsSummary = summaryParts.join('\n');

    // Save reflection log
    await this.prisma.aiReflectionLog.create({
      data: {
        evaluatedTurnsCount: traces.length,
        insightsSummary,
        identifiedGaps: JSON.stringify({
          rejectedCount: rejected.length,
          clarificationCount: clarifications.length,
          tier1Suggestions,
        }),
      },
    });

    return {
      evaluatedTurnsCount: traces.length,
      confirmedCount: confirmed.length,
      rejectedCount: rejected.length,
      clarificationCount: clarifications.length,
      insightsSummary,
      newExemplarsCount,
      tier1ParserSuggestions: tier1Suggestions,
    };
  }

  async getLatestReflectionLog() {
    return this.prisma.aiReflectionLog.findFirst({
      orderBy: { createdAt: 'desc' },
    });
  }

  async approveExemplar(exemplarId: string) {
    return this.prisma.aiLearnedExemplar.update({
      where: { id: exemplarId },
      data: { status: 'APPROVED' },
    });
  }
}
