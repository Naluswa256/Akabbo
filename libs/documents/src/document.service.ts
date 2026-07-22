import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DocumentStatus, ExtractionKind } from '@prisma/client';
import { OperationContext, PermissionService, assertEventWritable } from '@akabbo/access';
import { AuditWriter, OutboxWriter, TenantContext } from '@akabbo/ledger';
import { EXTRACTABLE_MIME } from './file.service';

export interface DocumentView {
  id: string;
  fileId: string;
  kind: ExtractionKind;
  status: DocumentStatus;
  error: string | null;
}

/**
 * Documents (blueprint §2.4). Submitting an uploaded file for extraction creates
 * a `document` and enqueues an outbox row — extraction runs ASYNCHRONOUSLY on the
 * worker (§7), never inline on the request. The user gets an immediate status
 * (UPLOADED → PROCESSING → REQUIRES_REVIEW).
 */
@Injectable()
export class DocumentService {
  constructor(
    private readonly tenant: TenantContext,
    private readonly permissions: PermissionService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  /** Submit an uploaded file for extraction. Returns immediately; work is async. */
  async submitForExtraction(
    ctx: OperationContext,
    fileId: string,
    kind: ExtractionKind = ExtractionKind.BUDGET,
  ): Promise<DocumentView> {
    this.permissions.assert(ctx.event.role, 'document:upload');
    assertEventWritable(ctx.event.status);

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      const file = await tx.fileObject.findFirst({
        where: { id: fileId },
        select: { id: true, mimeType: true },
      });
      if (!file) throw new NotFoundException('File not found in this event');
      if (!EXTRACTABLE_MIME.has(file.mimeType)) {
        throw new BadRequestException(
          `Cannot extract from ${file.mimeType} — upload an image or PDF`,
        );
      }

      const doc = await tx.document.create({
        data: {
          eventId: ctx.event.eventId,
          fileId,
          kind,
          status: DocumentStatus.UPLOADED,
          uploadedById: ctx.actor.userId,
        },
        select: { id: true, fileId: true, kind: true, status: true, error: true },
      });

      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'document:submit',
        resourceType: 'document',
        resourceId: doc.id,
        newValue: { fileId, kind },
      });

      // Async: the worker drains this and runs extraction (§7). Idempotent on
      // the document id so a redelivered outbox row never extracts twice.
      await this.outbox.enqueue(tx, {
        eventId: ctx.event.eventId,
        topic: 'document.uploaded',
        idempotencyKey: `document:${doc.id}`,
        payload: { documentId: doc.id },
      });

      return doc;
    });
  }

  async getDocument(ctx: OperationContext, documentId: string): Promise<DocumentView> {
    this.permissions.assert(ctx.event.role, 'document:read');
    const doc = await this.tenant.runInEvent(ctx.event.eventId, (tx) =>
      tx.document.findFirst({
        where: { id: documentId },
        select: { id: true, fileId: true, kind: true, status: true, error: true },
      }),
    );
    if (!doc) throw new NotFoundException('Document not found in this event');
    return doc;
  }
}
