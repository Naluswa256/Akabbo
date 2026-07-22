import { Module } from '@nestjs/common';
import { TransparencyModule } from '@akabbo/transparency';
import { PublicController } from './public.controller';
import { PublicRateLimitGuard } from './public-rate-limit.guard';

/**
 * The UNAUTHENTICATED public transparency surface (transparency spec Part 27).
 * Deliberately imports ONLY TransparencyModule — no AuthModule, no LedgerModule
 * write services — so there is structurally no path from a public request to a
 * mutation. Read-only by construction.
 */
@Module({
  imports: [TransparencyModule],
  controllers: [PublicController],
  providers: [PublicRateLimitGuard],
})
export class PublicApiModule {}
