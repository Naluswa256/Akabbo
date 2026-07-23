import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@akabbo/prisma';
import { redactPii } from './redaction-helper';

export interface TelemetryInput {
  conversationId?: string;
  eventId?: string;
  userId?: string;
  userPrompt: string;
  modelResponse?: string;
  toolCallsJson?: string;
  stagedStatus?: 'NONE' | 'CONFIRMED' | 'REJECTED' | 'CLARIFICATION';
  userRole?: string;
  latencyMs?: number;
}

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Async non-blocking telemetry logging for turn observation */
  async recordTrace(input: TelemetryInput): Promise<void> {
    try {
      await this.prisma.aiInteractionTrace.create({
        data: {
          conversationId: input.conversationId || null,
          eventId: input.eventId || null,
          userId: input.userId || null,
          userPrompt: redactPii(input.userPrompt),
          modelResponse: redactPii(input.modelResponse || ''),
          toolCallsJson: redactPii(input.toolCallsJson || ''),
          stagedStatus: input.stagedStatus || 'NONE',
          userRole: input.userRole || null,
          latencyMs: input.latencyMs || null,
          evaluated: false,
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to record AI interaction trace: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getRecentTraces(limit = 100) {
    return this.prisma.aiInteractionTrace.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
