import { Module } from '@nestjs/common';
import { TenantContext } from './tenant-context.service';
import { AuditWriter } from './audit.writer';
import { OutboxWriter } from './outbox.writer';
import { OutboxDrainService } from './outbox-drain.service';
import { EventService } from './event.service';
import { MembershipService } from './membership.service';
import { InvitationService } from './invitation.service';
import { PersonService } from './person.service';
import { PledgeService } from './pledge.service';
import { FulfillmentService } from './fulfillment.service';
import { BudgetService } from './budget.service';
import { AllocationService } from './allocation.service';
import { GroupService } from './group.service';
import { LedgerQueryService } from './ledger-query.service';
import { ReportService } from './report.service';

/**
 * The Ledger bounded context (the core, blueprint §2.1). One module, one
 * transactional boundary. Depends on PrismaModule (global) and AccessModule
 * (global) for the two gates. These services are the exact typed methods the AI
 * orchestrator will call as tools in Phase 2 — the AI gets no privileged path.
 */
@Module({
  providers: [
    TenantContext,
    AuditWriter,
    OutboxWriter,
    OutboxDrainService,
    EventService,
    MembershipService,
    InvitationService,
    PersonService,
    PledgeService,
    FulfillmentService,
    BudgetService,
    AllocationService,
    GroupService,
    LedgerQueryService,
    ReportService,
  ],
  exports: [
    // TenantContext is exported so the AI capture context (Phase 2) can scope
    // its own reads (entity resolution, usage meter, confirmations) to an event.
    TenantContext,
    // AuditWriter + OutboxWriter are exported so sibling contexts (Documents &
    // Extraction) share the one append-only audit trail and the one outbox.
    AuditWriter,
    OutboxWriter,
    OutboxDrainService,
    EventService,
    MembershipService,
    InvitationService,
    PersonService,
    PledgeService,
    FulfillmentService,
    BudgetService,
    AllocationService,
    GroupService,
    LedgerQueryService,
    ReportService,
  ],
})
export class LedgerModule {}
