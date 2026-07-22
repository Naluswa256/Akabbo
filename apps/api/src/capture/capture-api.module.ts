import { Module } from '@nestjs/common';
import { LedgerModule } from '@akabbo/ledger';
import { AiModule } from '@akabbo/ai';
import { AuthModule } from '../auth/auth.module';
import { CaptureController } from './capture.controller';

/**
 * HTTP surface for AI capture. Controllers only — the orchestration and both
 * gates live in AiModule/LedgerModule.
 */
@Module({
  imports: [AiModule, LedgerModule, AuthModule],
  controllers: [CaptureController],
})
export class CaptureApiModule {}
