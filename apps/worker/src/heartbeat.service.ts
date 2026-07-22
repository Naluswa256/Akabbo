import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '@akabbo/config';
import { PrismaService } from '@akabbo/prisma';

/**
 * Phase 0 worker workload: a periodic heartbeat.
 *
 * It proves the worker process is alive, on its own schedule, and can reach the
 * database — the Phase 0 DoD ("worker runs and logs a heartbeat"). From Phase 3
 * this loop is replaced by the real outbox drain (send SMS, run reminders,
 * async document extraction), all idempotent. Nothing here does business work.
 */
@Injectable()
export class HeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HeartbeatService.name);
  private timer?: NodeJS.Timeout;
  private ticks = 0;

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.config.workerHeartbeatMs;
    this.logger.log(`Worker heartbeat starting (every ${intervalMs}ms)`);
    // Emit one immediately so startup is observable without waiting a full tick.
    void this.tick();
    // The heartbeat timer is intentionally REF'd: it keeps the always-on worker
    // process alive (Cloud Run runs it with min-instances=1). From Phase 3 the
    // outbox drain loop takes over that role.
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One heartbeat: confirm DB reachability and log. Exposed for tests.
   * Failures are logged, never thrown — a transient DB blip must not crash the
   * worker; the next tick retries.
   */
  async tick(): Promise<void> {
    this.ticks += 1;
    try {
      await this.prisma.ping();
      this.logger.log(`heartbeat ok (tick=${this.ticks}, db=reachable)`);
    } catch (err) {
      this.logger.warn(
        `heartbeat degraded (tick=${this.ticks}, db=unreachable): ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  get tickCount(): number {
    return this.ticks;
  }
}
