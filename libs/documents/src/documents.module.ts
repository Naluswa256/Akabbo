import { Module } from '@nestjs/common';
import { LedgerModule } from '@akabbo/ledger';
import { AiModule } from '@akabbo/ai';
import { FileService } from './file.service';
import { DocumentService } from './document.service';
import { ExtractionService } from './extraction.service';

/**
 * Documents & Extraction (blueprint §2.4) — a bounded context. Uploads and
 * private storage, plus multimodal extraction that lands proposals as
 * pending_confirmation for human promotion. Depends on LedgerModule (budget,
 * tenant, audit, outbox) and AiModule (UsageMeter + the shared confirmation
 * machinery) and, via the global ProvidersModule, the LLM and Storage seams.
 */
@Module({
  imports: [LedgerModule, AiModule],
  providers: [FileService, DocumentService, ExtractionService],
  exports: [FileService, DocumentService, ExtractionService],
})
export class DocumentsModule {}
