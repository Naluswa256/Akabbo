import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule, AppConfigService } from '@akabbo/config';
import { PrismaModule } from '@akabbo/prisma';
import { ProvidersModule } from '@akabbo/providers';
import { AccessModule } from '@akabbo/access';
import { IdentityModule } from '@akabbo/identity';
import { buildLoggerParams } from '@akabbo/logging';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { LedgerApiModule } from './ledger/ledger-api.module';
import { CaptureApiModule } from './capture/capture-api.module';
import { AssistantApiModule } from './assistant/assistant-api.module';
import { DocumentsApiModule } from './documents/documents-api.module';
import { PublicApiModule } from './public/public-api.module';
import { TransparencyApiModule } from './transparency/transparency-api.module';
import { BillingApiModule } from './billing/billing-api.module';
import { SmsApiModule } from './sms/sms-api.module';

/**
 * API composition root (Phase 1).
 *
 * Foundations (config, logging, Prisma, providers) + the two-gate AccessModule
 * + IdentityModule (real auth) + the Ledger HTTP surface. No AI, SMS, or
 * billing modules yet — those are later phases.
 */
@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        buildLoggerParams({
          role: 'api',
          level: config.logLevel,
          pretty: !config.isProduction,
        }),
    }),
    PrismaModule,
    ProvidersModule,
    AccessModule,
    IdentityModule,
    HealthModule,
    AuthModule,
    LedgerApiModule,
    CaptureApiModule,
    AssistantApiModule,
    DocumentsApiModule,
    TransparencyApiModule,
    PublicApiModule,
    BillingApiModule,
    SmsApiModule,
  ],
})
export class AppModule {}
