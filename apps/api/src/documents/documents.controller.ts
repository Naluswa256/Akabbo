import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Actor, OperationContext } from '@akabbo/access';
import { MembershipService } from '@akabbo/ledger';
import { DocumentService, FileService } from '@akabbo/documents';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentActor } from '../auth/current-actor.decorator';
import { SubmitDocumentDto, UploadFileDto } from './documents.dto';

/**
 * Documents & files surface (§10, §17, §31). Uploads are validated and stored
 * privately; retrieval is a short-lived signed URL. Submitting a file for
 * extraction runs asynchronously — the client polls the document status, and
 * confirms extracted budget lines via the shared `/pending` endpoints.
 */
@Controller('events/:eventId')
@UseGuards(AuthGuard)
export class DocumentsController {
  constructor(
    private readonly membership: MembershipService,
    private readonly files: FileService,
    private readonly documents: DocumentService,
  ) {}

  private ctx(actor: Actor, eventId: string): Promise<OperationContext> {
    return this.membership.requireContext(actor, eventId).then((event) => ({ actor, event }));
  }

  @Post('files')
  async upload(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: UploadFileDto,
  ) {
    return this.files.upload(await this.ctx(actor, eventId), {
      kind: dto.kind,
      mimeType: dto.mimeType,
      body: Buffer.from(dto.dataBase64, 'base64'),
      filename: dto.filename,
      personId: dto.personId,
    });
  }

  /** A short-lived signed URL to fetch the private object (§10). */
  @Get('files/:fileId/url')
  async signedUrl(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Param('fileId') fileId: string,
  ) {
    const url = await this.files.getSignedUrl(await this.ctx(actor, eventId), fileId);
    return { url };
  }

  /** Submit an uploaded file for async multimodal extraction (§10, §31). */
  @Post('documents')
  async submit(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Body() dto: SubmitDocumentDto,
  ) {
    return this.documents.submitForExtraction(await this.ctx(actor, eventId), dto.fileId, dto.kind);
  }

  @Get('documents/:documentId')
  async status(
    @CurrentActor() actor: Actor,
    @Param('eventId') eventId: string,
    @Param('documentId') documentId: string,
  ) {
    return this.documents.getDocument(await this.ctx(actor, eventId), documentId);
  }
}
