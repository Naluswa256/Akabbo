import { Inject, Injectable, Logger } from '@nestjs/common';
import { DocumentStatus, Prisma, ProvenanceSource } from '@prisma/client';
import { LLM_PROVIDER, LlmProvider } from '@akabbo/providers';
import { TenantContext } from '@akabbo/ledger';
import { StoredAction, UsageMeter, costMicroUsd, parseAmountToMinorUnits } from '@akabbo/ai';
import { FileService } from './file.service';
import {
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACT_BUDGET_TOOL,
  extractBudgetResult,
} from './extraction-contract';

export interface ExtractionResult {
  documentId: string;
  status: DocumentStatus;
  proposedItems: number;
}

/**
 * Multimodal document extraction (blueprint §5, §6.1). Invoked by the WORKER
 * (async, §7) with the event scope from the outbox row. It:
 *   1. reads the document bytes and passes them to the LLM as an ATTACHMENT
 *      (data channel, never the system prompt — §10);
 *   2. records the raw structured reading as an append-only `extraction` row
 *      with provenance (model, confidence);
 *   3. lands each proposed budget line as a `pending_confirmation` — NOT
 *      canonical. A human promotes it via ConfirmationService, at which point a
 *      human is stamped into the provenance chain and the budget item is created
 *      with `ai_from_document` + a link back to the source document.
 *
 * An instruction embedded in the document cannot self-execute: the only tool the
 * model may call is `extract_budget`, and its output is a proposal a human must
 * approve.
 */
@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly tenant: TenantContext,
    private readonly files: FileService,
    private readonly meter: UsageMeter,
  ) {}

  async process(eventId: string, documentId: string): Promise<ExtractionResult> {
    // Load + mark PROCESSING (idempotent guard: skip if already past UPLOADED).
    const doc = await this.tenant.runInEvent(eventId, async (tx) => {
      const d = await tx.document.findFirst({
        where: { id: documentId },
        select: { id: true, fileId: true, status: true, uploadedById: true },
      });
      if (!d) return null;
      if (d.status !== DocumentStatus.UPLOADED) return null; // already handled
      await tx.document.update({
        where: { id: documentId },
        data: { status: DocumentStatus.PROCESSING, attempts: { increment: 1 } },
      });
      return d;
    });
    if (!doc) return { documentId, status: DocumentStatus.PROCESSED, proposedItems: 0 };

    try {
      const file = await this.files.readBytes(eventId, doc.fileId);

      const result = await this.llm.complete({
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: 'Extract the budget line items from the attached document.' },
        ],
        tools: [{ ...EXTRACT_BUDGET_TOOL, parameters: { ...EXTRACT_BUDGET_TOOL.parameters } }],
        attachments: [{ mimeType: file.mimeType, data: file.body }],
        temperature: 0,
        // Extraction must return the structured tool call, not prose.
        toolChoice: 'required',
      });

      await this.meter.recordLlmCall(eventId, result.usage, costMicroUsd(result.usage), {
        kind: 'document_extraction',
        documentId,
      });

      const raw = result.toolCalls.find((c) => c.name === 'extract_budget');
      const parsed = extractBudgetResult.safeParse(raw?.arguments ?? {});
      const items = parsed.success ? parsed.data.items : [];
      const confidence = parsed.success ? parsed.data.confidence : undefined;

      // Normalise amounts; drop anything that isn't a real figure.
      const normalized = items
        .map((it) => ({ name: it.name, amount: parseAmountToMinorUnits(String(it.amount)) }))
        .filter((it): it is { name: string; amount: bigint } => it.amount !== null);

      const proposedItems = await this.tenant.runInEvent(eventId, async (tx) => {
        await tx.extraction.create({
          data: {
            eventId,
            documentId,
            kind: 'BUDGET',
            structured: {
              items: normalized.map((n) => ({ name: n.name, amount: n.amount.toString() })),
            },
            confidence: confidence ?? null,
            model: result.usage.model,
            itemCount: normalized.length,
          },
        });

        for (const item of normalized) {
          const action: StoredAction = {
            tool: 'create_budget_item',
            name: item.name,
            targetValue: item.amount.toString(),
            sourceDocumentId: documentId,
          };
          await tx.pendingConfirmation.create({
            data: {
              eventId,
              intent: 'create_budget_item',
              payload: action as unknown as Prisma.InputJsonValue,
              confidence: confidence ?? null,
              source: ProvenanceSource.ai_from_document,
              prompt: `I read a budget line “${item.name}” of ${item.amount.toString()} — add it?`,
              createdById: doc.uploadedById,
            },
          });
        }

        await tx.document.update({
          where: { id: documentId },
          data: { status: DocumentStatus.REQUIRES_REVIEW, processedAt: new Date() },
        });
        return normalized.length;
      });

      return { documentId, status: DocumentStatus.REQUIRES_REVIEW, proposedItems };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'extraction failed';
      this.logger.warn(`Extraction failed for document ${documentId}: ${message}`);
      await this.tenant.runInEvent(eventId, (tx) =>
        tx.document.update({
          where: { id: documentId },
          data: { status: DocumentStatus.FAILED, error: message.slice(0, 500) },
        }),
      );
      return { documentId, status: DocumentStatus.FAILED, proposedItems: 0 };
    }
  }
}
