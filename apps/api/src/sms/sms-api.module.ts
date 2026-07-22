import { Module } from '@nestjs/common';
import { LedgerModule } from '@akabbo/ledger';
import { CommsModule } from '@akabbo/comms';
import { AuthModule } from '../auth/auth.module';
import { SmsController } from './sms.controller';

/** HTTP surface for Communications — reminders, announcements, delivery (§34). */
@Module({
  imports: [CommsModule, LedgerModule, AuthModule],
  controllers: [SmsController],
})
export class SmsApiModule {}
