import { Module } from '@nestjs/common';
import { LedgerModule } from '@akabbo/ledger';
import { TransparencyModule } from '@akabbo/transparency';
import { AuthModule } from '../auth/auth.module';
import { TransparencyController } from './transparency.controller';

/** Authed organizer control plane for the public transparency layer (Phase 5). */
@Module({
  imports: [TransparencyModule, LedgerModule, AuthModule],
  controllers: [TransparencyController],
})
export class TransparencyApiModule {}
