import { Module } from '@nestjs/common';
import { LedgerModule } from '@akabbo/ledger';
import { PublicViewService } from './public-view.service';
import { PublicSettingsService } from './public-settings.service';
import { AnnouncementService } from './announcement.service';
import { PaymentInstructionService } from './payment-instruction.service';

/**
 * Public Event Transparency (transparency spec). Two faces of one ledger:
 *  • PublicViewService  — the UNAUTHENTICATED read projection for the shareable
 *    link. Takes a slug (+token), never an actor. The deliberate boundary.
 *  • PublicSettings / Announcement / PaymentInstruction — the ORGANIZER-side
 *    management of what the public sees, gated by the permission matrix.
 *
 * Depends on LedgerModule for TenantContext (RLS scoping), AuditWriter, and the
 * money helpers; on AccessModule (global) for the permission gate; and on
 * PrismaModule (global) for the non-RLS `event`-by-slug resolution.
 */
@Module({
  imports: [LedgerModule],
  providers: [
    PublicViewService,
    PublicSettingsService,
    AnnouncementService,
    PaymentInstructionService,
  ],
  exports: [
    PublicViewService,
    PublicSettingsService,
    AnnouncementService,
    PaymentInstructionService,
  ],
})
export class TransparencyModule {}
