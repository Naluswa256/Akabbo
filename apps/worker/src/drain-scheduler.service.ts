import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '@akabbo/config';
import { OutboxDrainService } from '@akabbo/ledger';

/**
 * Polls the outbox drain on a schedule (blueprint §7). This is the worker's
 * real job: turning recorded facts into side effects (document extraction now;
 * SMS fan-out in Phase 3) asynchronously, off the request path. Ticks are
 * serialised so two drains never overlap in one process.
 */
@Injectable()
export class DrainSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DrainSchedulerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly drain: OutboxDrainService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.config.workerHeartbeatMs;
    this.logger.log(`Outbox drain scheduler starting (every ${intervalMs}ms)`);
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // never overlap ticks
    this.running = true;
    try {
      const handled = await this.drain.drainOnce();
      if (handled > 0) this.logger.log(`Drained ${handled} outbox message(s)`);
    } catch (err) {
      this.logger.warn(
        `Drain tick failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    } finally {
      this.running = false;
    }
  }
}
