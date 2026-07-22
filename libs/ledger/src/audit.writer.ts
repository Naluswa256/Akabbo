import { Injectable } from '@nestjs/common';
import { Prisma, ProvenanceSource } from '@prisma/client';
import { TenantTx } from './tenant-context.service';

export interface AuditInput {
  eventId: string;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  source?: ProvenanceSource;
  /** null for creates. */
  oldValue?: Prisma.InputJsonValue | null;
  newValue?: Prisma.InputJsonValue | null;
}

/**
 * Writes the append-only audit_event (§3.1). Always called with the SAME `tx`
 * as the mutation it records, so the record and its audit commit atomically —
 * there is no window in which a change exists without its provenance. History
 * is immutable (a DB trigger blocks UPDATE/DELETE); corrections are new rows.
 */
@Injectable()
export class AuditWriter {
  write(tx: TenantTx, input: AuditInput): Promise<{ id: string }> {
    return tx.auditEvent.create({
      data: {
        eventId: input.eventId,
        actorUserId: input.actorUserId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        source: input.source ?? ProvenanceSource.human_typed,
        oldValue: input.oldValue ?? Prisma.JsonNull,
        newValue: input.newValue ?? Prisma.JsonNull,
      },
      select: { id: true },
    });
  }
}
