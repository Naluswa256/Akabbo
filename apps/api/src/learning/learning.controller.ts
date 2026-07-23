import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { SelfLearningService, TelemetryService } from '@akabbo/ai';
import { AuthGuard } from '../auth/auth.guard';

@Controller('ai/learning')
@UseGuards(AuthGuard)
export class LearningController {
  constructor(
    private readonly selfLearning: SelfLearningService,
    private readonly telemetry: TelemetryService,
  ) {}

  @Get('metrics')
  async getMetrics() {
    const traces = await this.telemetry.getRecentTraces(50);
    const latestLog = await this.selfLearning.getLatestReflectionLog();
    return {
      recentTracesCount: traces.length,
      latestReflectionLog: latestLog,
    };
  }

  @Post('evaluate')
  async triggerEvaluation() {
    return this.selfLearning.runEvaluationCycle(100);
  }
}
