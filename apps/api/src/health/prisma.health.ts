import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { PrismaService } from '@akabbo/prisma';

/**
 * Terminus health indicator that proves the database connection is usable by
 * running a trivial round-trip (`SELECT 1`). This is what makes the Phase 0
 * readiness check meaningful: a green result means the skeleton really reached
 * Neon, not just that the process booted.
 */
@Injectable()
export class PrismaHealthIndicator extends HealthIndicator {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      await this.prisma.ping();
      return this.getStatus(key, true);
    } catch (err) {
      throw new HealthCheckError(
        'Database ping failed',
        this.getStatus(key, false, {
          message: err instanceof Error ? err.message : 'unknown error',
        }),
      );
    }
  }
}
