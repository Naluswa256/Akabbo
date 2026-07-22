import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Minimal per-IP fixed-window rate limiter for the UNAUTHENTICATED public
 * surface (transparency spec Part 13/20). The public link may be shared widely,
 * so this is basic abuse protection — a real edge/CDN + WAF is the production
 * answer (deferred to ops), but the seam is here so the endpoint is never
 * naked. In-memory and per-process: good enough for a single instance and a
 * safety net behind a shared limiter later.
 */
@Injectable()
export class PublicRateLimitGuard implements CanActivate {
  private readonly windowMs = 60_000;
  private readonly max = 240; // requests per IP per window
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const now = Date.now();

    const entry = this.hits.get(ip);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(ip, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return true;
    }
    entry.count += 1;
    if (entry.count > this.max) {
      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }

  /** Opportunistic cleanup so the map cannot grow unbounded. */
  private sweep(now: number): void {
    if (this.hits.size < 10_000) return;
    for (const [ip, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(ip);
    }
  }
}
