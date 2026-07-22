import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule, AppConfigService } from '@akabbo/config';
import { PrismaModule } from '@akabbo/prisma';
import { ProvidersModule } from '@akabbo/providers';
import { AccessModule } from '@akabbo/access';
import { IdentityModule } from '@akabbo/identity';
import { LedgerModule } from '@akabbo/ledger';
import { AiModule } from '@akabbo/ai';
import { DocumentsModule } from '@akabbo/documents';
import { CommsModule } from '@akabbo/comms';
import { buildLoggerParams } from '@akabbo/logging';
import { HeartbeatService } from './heartbeat.service';
import { DrainSchedulerService } from './drain-scheduler.service';
import { OutboxHandlersRegistrar } from './outbox-handlers.registrar';

/**
 * Worker composition root. Same codebase and foundations as the API, a separate
 * process. It drains the transactional outbox (blueprint §7): recorded facts →
 * side effects, asynchronously. Topic handlers are registered here — Phase 4
 * wires `document.uploaded` → multimodal extraction; Phase 3 adds SMS fan-out.
 */
@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        buildLoggerParams({
          role: 'worker',
          level: config.logLevel,
          pretty: !config.isProduction,
        }),
    }),
    PrismaModule,
    ProvidersModule,
    AccessModule,
    IdentityModule,
    LedgerModule,
    AiModule,
    DocumentsModule,
    CommsModule,
  ],
  providers: [HeartbeatService, DrainSchedulerService, OutboxHandlersRegistrar],
})
export class WorkerModule {}
