import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { PrismaHealthIndicator } from './prisma.health';

/**
 * Liveness + readiness endpoints.
 *
 * `/health` — cheap liveness (is the process up?). Used by Cloud Run's startup/
 *   liveness probes and excluded from request logging (it is frequent + boring).
 * `/health/ready` — readiness (can it actually serve?): proves DB reachability.
 *   This is the Phase 0 DoD signal that the skeleton is wired to Neon.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  liveness(): HealthCheckResult {
    return {
      status: 'ok',
      info: {},
      error: {},
      details: {},
    };
  }

  @Get('ready')
  @HealthCheck()
  readiness(): Promise<HealthCheckResult> {
    return this.health.check([
      (): Promise<HealthIndicatorResult> => this.prisma.isHealthy('database'),
    ]);
  }
}
