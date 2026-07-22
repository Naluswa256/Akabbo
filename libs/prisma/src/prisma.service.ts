import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Managed Prisma client bound to the Nest lifecycle.
 *
 * Connects on module init and disconnects on shutdown. In Phase 0 this proves
 * DB reachability for the health check; from Phase 1 it is the single
 * transactional boundary through which every mutation + audit_event + outbox
 * row commit together (CLAUDE.md §8 "Transactions are sacred").
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected');
  }

  /**
   * Lightweight liveness probe for the health endpoint. Runs the cheapest
   * possible round-trip to confirm the connection is actually usable.
   */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
