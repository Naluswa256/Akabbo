import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SelfLearningService, TelemetryService } from '@akabbo/ai';
import { AuthGuard } from '../auth/auth.guard';

@Controller('ai/learning')
@UseGuards(AuthGuard)
export class LearningController {
  constructor(
    private readonly selfLearning: SelfLearningService,
    private readonly telemetry: TelemetryService,
  ) {}

  private assertAdminSecret(secretHeader?: string): void {
    const adminSecret = process.env.ADMIN_SECRET || 'akabbo-admin-secret-dev';
    if (!secretHeader || secretHeader !== adminSecret) {
      throw new ForbiddenException('Invalid admin secret key for self-learning surface');
    }
  }

  @Get('metrics')
  async getMetrics(@Headers('x-akabbo-admin-secret') secret?: string) {
    this.assertAdminSecret(secret);
    const traces = await this.telemetry.getRecentTraces(50);
    const latestLog = await this.selfLearning.getLatestReflectionLog();
    return {
      recentTracesCount: traces.length,
      latestReflectionLog: latestLog,
    };
  }

  @Post('evaluate')
  async triggerEvaluation(@Headers('x-akabbo-admin-secret') secret?: string) {
    this.assertAdminSecret(secret);
    return this.selfLearning.runEvaluationCycle(100);
  }

  @Post('exemplars/:id/approve')
  async approveExemplar(
    @Param('id') id: string,
    @Headers('x-akabbo-admin-secret') secret?: string,
  ) {
    this.assertAdminSecret(secret);
    return this.selfLearning.approveExemplar(id);
  }
}
