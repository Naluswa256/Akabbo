import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SelfLearningService } from '@akabbo/ai';

/**
 * Periodically runs the Self-Learning Reflection Evaluation loop in the background.
 * Evaluates un-evaluated interaction traces, distills candidate exemplars, and
 * updates accuracy statistics off the main API request path.
 */
@Injectable()
export class LearningSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LearningSchedulerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  // Default evaluation cycle: every 6 hours (6 * 3600 * 1000 ms)
  private readonly INTERVAL_MS = 6 * 60 * 60 * 1000;

  constructor(private readonly selfLearning: SelfLearningService) {}

  onModuleInit(): void {
    this.logger.log(`Self-Learning evaluation scheduler starting (every 6 hours)`);
    this.timer = setInterval(() => void this.tick(), this.INTERVAL_MS);
    // Initial evaluation tick after 1 minute of worker boot
    setTimeout(() => void this.tick(), 60000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const res = await this.selfLearning.runEvaluationCycle(100);
      if (res.evaluatedTurnsCount > 0) {
        this.logger.log(
          `Self-learning evaluation cycle complete: evaluated ${res.evaluatedTurnsCount} turn(s), created ${res.newExemplarsCount} candidate exemplar(s)`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Self-learning evaluation tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
