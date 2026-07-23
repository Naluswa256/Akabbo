import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@akabbo/prisma';

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
          userPrompt: input.userPrompt,
          modelResponse: input.modelResponse || null,
          toolCallsJson: input.toolCallsJson || null,
          stagedStatus: input.stagedStatus || 'NONE',
          userRole: input.userRole || null,
          latencyMs: input.latencyMs || null,
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
