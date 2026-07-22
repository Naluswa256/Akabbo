import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { FileKind } from '@prisma/client';
import { AppConfigService } from '@akabbo/config';
import { OperationContext, PermissionService, assertEventWritable } from '@akabbo/access';
import { STORAGE_PROVIDER, StorageProvider } from '@akabbo/providers';
import { AuditWriter, TenantContext } from '@akabbo/ledger';

/** MIME types we accept. Images + PDF are extractable by the multimodal model. */
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
]);

/** MIME types the multimodal model can read directly (§5). */
export const EXTRACTABLE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
]);

export interface UploadFileInput {
  kind: FileKind;
  mimeType: string;
  body: Buffer;
  filename?: string;
  /** Attach to a person (contributor photo / evidence, §17). */
  personId?: string;
}

export interface FileView {
  id: string;
  kind: FileKind;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  originalFilename: string | null;
}

/**
 * Files (§17, §31). Uploads are authenticated, authorized, size/type-validated,
 * content-hashed, and stored PRIVATELY behind the {@link StorageProvider} seam
 * (local now, R2 in prod). Retrieval is only ever via a short-lived, signed URL
 * handed out AFTER a permission check — the bytes are never public (§10).
 */
@Injectable()
export class FileService {
  constructor(
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly tenant: TenantContext,
    private readonly permissions: PermissionService,
    private readonly audit: AuditWriter,
    private readonly config: AppConfigService,
  ) {}

  async upload(ctx: OperationContext, input: UploadFileInput): Promise<FileView> {
    this.permissions.assert(ctx.event.role, 'document:upload');
    assertEventWritable(ctx.event.status);

    if (!ALLOWED_MIME.has(input.mimeType)) {
      throw new BadRequestException(`Unsupported file type: ${input.mimeType}`);
    }
    const maxBytes = this.config.get('MAX_UPLOAD_BYTES');
    if (input.body.length === 0) throw new BadRequestException('Empty file');
    if (input.body.length > maxBytes) {
      throw new BadRequestException(`File exceeds ${maxBytes} bytes`);
    }

    const sha256 = createHash('sha256').update(input.body).digest('hex');
    const ext = input.filename?.includes('.') ? `.${input.filename.split('.').pop()}` : '';
    const storageKey = `events/${ctx.event.eventId}/${randomUUID()}${ext}`;

    // Store the bytes first; the DB row is the index into storage.
    await this.storage.putObject({
      key: storageKey,
      body: input.body,
      contentType: input.mimeType,
    });

    return this.tenant.runInEvent(ctx.event.eventId, async (tx) => {
      if (input.personId) {
        const person = await tx.person.findFirst({
          where: { id: input.personId },
          select: { id: true },
        });
        if (!person) throw new NotFoundException('Person not found in this event');
      }

      const file = await tx.fileObject.create({
        data: {
          eventId: ctx.event.eventId,
          kind: input.kind,
          storageKey,
          mimeType: input.mimeType,
          sizeBytes: input.body.length,
          sha256,
          originalFilename: input.filename ?? null,
          personId: input.personId ?? null,
          uploadedById: ctx.actor.userId,
        },
        select: {
          id: true,
          kind: true,
          mimeType: true,
          sizeBytes: true,
          sha256: true,
          originalFilename: true,
        },
      });

      await this.audit.write(tx, {
        eventId: ctx.event.eventId,
        actorUserId: ctx.actor.userId,
        action: 'file:upload',
        resourceType: 'file_object',
        resourceId: file.id,
        newValue: { kind: file.kind, mimeType: file.mimeType, sha256: file.sha256 },
      });

      return file;
    });
  }

  /** A short-lived signed URL, only after a permission check (§10). */
  async getSignedUrl(
    ctx: OperationContext,
    fileId: string,
    expiresInSeconds = 300,
  ): Promise<string> {
    this.permissions.assert(ctx.event.role, 'document:read');
    const file = await this.tenant.runInEvent(ctx.event.eventId, (tx) =>
      tx.fileObject.findFirst({ where: { id: fileId }, select: { storageKey: true } }),
    );
    if (!file) throw new NotFoundException('File not found in this event');
    return this.storage.getSignedUrl({
      key: file.storageKey,
      expiresInSeconds,
      operation: 'get',
    });
  }

  /**
   * Server-side byte read for the extraction worker (no user context — scoped to
   * the event from the outbox row). NOT a user-facing path.
   */
  async readBytes(eventId: string, fileId: string): Promise<{ mimeType: string; body: Buffer }> {
    const file = await this.tenant.runInEvent(eventId, (tx) =>
      tx.fileObject.findFirst({
        where: { id: fileId },
        select: { storageKey: true, mimeType: true },
      }),
    );
    if (!file) throw new NotFoundException('File not found');
    const body = await this.storage.getObject(file.storageKey);
    return { mimeType: file.mimeType, body };
  }
}
