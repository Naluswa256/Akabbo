import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@akabbo/prisma';
import { LLM_PROVIDER, LlmProvider } from '@akabbo/providers';

export interface EvaluationResult {
  evaluatedTurnsCount: number;
  confirmedCount: number;
  rejectedCount: number;
  clarificationCount: number;
  insightsSummary: string;
  newExemplarsCount: number;
}

@Injectable()
export class SelfLearningService {
  private readonly logger = new Logger(SelfLearningService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  /**
   * Offline Reflection Loop: Evaluates recent interaction traces,
   * analyzes tool outcomes, rejected actions, and clarification patterns,
   * and distills self-improving exemplars.
   */
  async runEvaluationCycle(limit = 50): Promise<EvaluationResult> {
    const traces = await this.prisma.aiInteractionTrace.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    if (traces.length === 0) {
      return {
        evaluatedTurnsCount: 0,
        confirmedCount: 0,
        rejectedCount: 0,
        clarificationCount: 0,
        insightsSummary: 'No interaction traces found to evaluate.',
        newExemplarsCount: 0,
      };
    }

    const confirmed = traces.filter((t) => t.stagedStatus === 'CONFIRMED');
    const rejected = traces.filter((t) => t.stagedStatus === 'REJECTED');
    const clarifications = traces.filter((t) => t.stagedStatus === 'CLARIFICATION');

    const summaryParts: string[] = [
      `Evaluated ${traces.length} recent interaction turns:`,
      `• ${confirmed.length} actions confirmed by users.`,
      `• ${rejected.length} actions rejected/cancelled by users.`,
      `• ${clarifications.length} turns required user clarification.`,
    ];

    let newExemplarsCount = 0;

    // Distill learning points from rejected or clarification turns
    if (rejected.length > 0 || clarifications.length > 0) {
      const problematicPrompts = [...rejected, ...clarifications]
        .map((t) => `Prompt: "${t.userPrompt}" -> Tool: ${t.toolCallsJson ?? 'none'}`)
        .slice(0, 10)
        .join('\n');

      try {
        const evalPrompt = [
          'Analyze these AI interaction traces where users rejected an action or needed clarification:',
          problematicPrompts,
          '',
          'Provide 1 concise rule/exemplar for how the AI can improve its interpretation of similar requests in the future.',
        ].join('\n');

        const completion = await this.llm.complete({
          messages: [{ role: 'user', content: evalPrompt }],
          tools: [],
          temperature: 0.2,
        });

        const distilledGuidance = completion.text?.trim();
        if (distilledGuidance && distilledGuidance.length > 10) {
          summaryParts.push(`\nDistilled Insight:\n${distilledGuidance}`);

          await this.prisma.aiLearnedExemplar.create({
            data: {
              category: 'REFLECTION_INSIGHT',
              triggerKeywords: ['help', 'correct', 'pledge', 'payment', 'kwanjula'],
              userPromptPattern: 'Reflection from rejected/clarified turns',
              learnedGuidance: distilledGuidance,
              confidenceScore: 0.9,
              status: 'APPROVED',
            },
          });
          newExemplarsCount += 1;
        }
      } catch (err) {
        this.logger.warn(`LLM evaluation distillation warning: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const insightsSummary = summaryParts.join('\n');

    // Save reflection log
    await this.prisma.aiReflectionLog.create({
      data: {
        evaluatedTurnsCount: traces.length,
        insightsSummary,
        identifiedGaps: JSON.stringify({
          rejectedCount: rejected.length,
          clarificationCount: clarifications.length,
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
    };
  }

  async getLatestReflectionLog() {
    return this.prisma.aiReflectionLog.findFirst({
      orderBy: { createdAt: 'desc' },
    });
  }
}
