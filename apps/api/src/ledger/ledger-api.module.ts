import { Module } from '@nestjs/common';
import { LedgerModule } from '@akabbo/ledger';
import { AuthModule } from '../auth/auth.module';
import { EventsController } from './events.controller';
import { LedgerController } from './ledger.controller';
import { InvitationController } from '../invitation/invitation.controller';

/**
 * HTTP surface for the Ledger context. Controllers only — all logic and the two
 * gates live in the domain services provided by LedgerModule.
 */
@Module({
  imports: [LedgerModule, AuthModule],
  controllers: [EventsController, LedgerController, InvitationController],
})
export class LedgerApiModule {}
