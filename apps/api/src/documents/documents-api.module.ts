import { Module } from '@nestjs/common';
import { LedgerModule } from '@akabbo/ledger';
import { DocumentsModule } from '@akabbo/documents';
import { AuthModule } from '../auth/auth.module';
import { DocumentsController } from './documents.controller';

/** HTTP surface for Documents & Extraction (Phase 4). */
@Module({
  imports: [DocumentsModule, LedgerModule, AuthModule],
  controllers: [DocumentsController],
})
export class DocumentsApiModule {}
