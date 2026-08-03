import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BudgetKnowledgeExtractionMethod,
  BudgetKnowledgeReliability,
  BudgetKnowledgeSourceType,
  DocumentStatus,
  ExtractionKind,
  Prisma,
  ProvenanceSource,
} from '@prisma/client';
import { LLM_PROVIDER, LlmProvider } from '@akabbo/providers';
import { TenantContext, MembershipService } from '@akabbo/ledger';
import { StoredAction, UsageMeter, costMicroUsd, parseAmountToMinorUnits, CaptureService } from '@akabbo/ai';
import { BudgetKnowledgeService } from '@akabbo/budget-intelligence';
import { FileService } from './file.service';
import {
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACT_BUDGET_TOOL,
  extractBudgetResult,
} from './extraction-contract';
import {
  CONTRIBUTION_EXTRACTION_SYSTEM_PROMPT,
  EXTRACT_CONTRIBUTIONS_TOOL,
  ExtractedContributionEntry,
  extractContributionsResult,
} from './contribution-extraction-contract';

export interface ExtractionResult {
  documentId: string;
  status: DocumentStatus;
  proposedItems: number;
}

type LoadedDoc = { id: string; fileId: string; status: DocumentStatus; uploadedById: string | null; kind: ExtractionKind };

/**
 * Multimodal document extraction (blueprint §5, §6.1). Invoked by the WORKER
 * (async, §7) with the event scope from the outbox row. Dispatches on
 * `Document.kind`:
 *   - BUDGET (and UNKNOWN, for backward compatibility): reads a photographed
 *     budget, lands each line as a `pending_confirmation` for `create_budget_item`.
 *   - CONTRIBUTION_LIST: reads a photographed contributor/pledge list, stages
 *     each entry through the SAME natural-language capture pipeline chat uses
 *     (CaptureService) — no separate entity-resolution or staging logic here,
 *     it's the exact code path a human typing "Mbonye Emma paid 20,000" in
 *     chat already goes through.
 *
 * Nothing here is canonical. A human promotes each proposal via
 * ConfirmationService, at which point a human is stamped into the provenance
 * chain. An instruction embedded in the document cannot self-execute: the
 * only tool the model may call is the extraction tool, and its output is
 * always a proposal a human must approve.
 */
@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly tenant: TenantContext,
    private readonly files: FileService,
    private readonly meter: UsageMeter,
    private readonly budgetKnowledge: BudgetKnowledgeService,
    private readonly capture: CaptureService,
    private readonly membership: MembershipService,
  ) {}

  async process(eventId: string, documentId: string): Promise<ExtractionResult> {
    // Load + mark PROCESSING (idempotent guard: skip if already past UPLOADED).
    const doc = await this.tenant.runInEvent(eventId, async (tx) => {
      const d = await tx.document.findFirst({
        where: { id: documentId },
        select: { id: true, fileId: true, status: true, uploadedById: true, kind: true },
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

    if (doc.kind === ExtractionKind.CONTRIBUTION_LIST) {
      return this.processContributionList(eventId, documentId, doc);
    }
    return this.processBudget(eventId, documentId, doc);
  }

  private async processBudget(
    eventId: string,
    documentId: string,
    doc: LoadedDoc,
  ): Promise<ExtractionResult> {
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
      const documentTitle = parsed.success ? parsed.data.document_title : undefined;
      const currency = parsed.success ? parsed.data.currency : 'UGX';
      const notes = parsed.success ? parsed.data.notes : undefined;

      // Normalise amounts; drop anything that isn't a real figure.
      const normalized = items
        .map((it) => {
          const amt = parseAmountToMinorUnits(String(it.amount));
          if (amt === null) return null;
          return {
            name: it.name,
            amount: amt,
            quantity: it.quantity ?? null,
            unitCost: it.unit_cost ? parseAmountToMinorUnits(String(it.unit_cost))?.toString() ?? null : null,
            categoryContext: it.category_context ?? null,
            conceptType: it.concept_type ?? null,
            fulfillmentStatus: it.fulfillment_status ?? 'unknown',
            isPartiallyIllegible: it.is_partially_illegible ?? false,
          };
        })
        .filter((it): it is NonNullable<typeof it> => it !== null);

      const proposedItems = await this.tenant.runInEvent(eventId, async (tx) => {
        await tx.extraction.create({
          data: {
            eventId,
            documentId,
            kind: 'BUDGET',
            structured: {
              documentTitle,
              currency,
              notes,
              items: normalized.map((n) => ({
                name: n.name,
                amount: n.amount.toString(),
                quantity: n.quantity,
                unitCost: n.unitCost,
                categoryContext: n.categoryContext,
                conceptType: n.conceptType,
                fulfillmentStatus: n.fulfillmentStatus,
                isPartiallyIllegible: n.isPartiallyIllegible,
              })),
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

          const details = [
            item.quantity ? `Qty: ${item.quantity}` : null,
            item.categoryContext ? `Category: ${item.categoryContext}` : null,
            item.fulfillmentStatus && item.fulfillmentStatus !== 'unknown' ? `Status: ${item.fulfillmentStatus}` : null,
          ].filter(Boolean).join(', ');

          const promptText = details
            ? `I read a budget line “${item.name}” (${details}) of UGX ${item.amount.toString()} — add it?`
            : `I read a budget line “${item.name}” of UGX ${item.amount.toString()} — add it?`;

          await tx.pendingConfirmation.create({
            data: {
              eventId,
              intent: 'create_budget_item',
              payload: action as unknown as Prisma.InputJsonValue,
              confidence: confidence ?? null,
              source: ProvenanceSource.ai_from_document,
              prompt: promptText,
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

      // Best-effort: also feed Akabbo's shared budget-knowledge base
      // (pre-budgeting) from this organizer's own budget — PII-free by
      // construction (budget line items are category/amount data, never
      // contributor names/phones) and gated to BUDGET-kind documents only,
      // never CONTRIBUTION_LIST. Never blocks or fails the per-event
      // extraction above, which has already completed by this point.
      if (
        doc.kind === ExtractionKind.BUDGET &&
        parsed.success &&
        parsed.data.inferred_event_type &&
        normalized.length > 0
      ) {
        try {
          await this.budgetKnowledge.ingestObservations(
            {
              sourceType: BudgetKnowledgeSourceType.user_upload,
              name: `user-upload:${documentId}`,
              reliability: BudgetKnowledgeReliability.LOW,
              licensingNote:
                "One organizer's own uploaded budget — a single anecdote, not a market survey. Disclosed via Akabbo's terms of service.",
              extractionMethod: BudgetKnowledgeExtractionMethod.ai_extraction_live,
            },
            normalized.map((n) => ({
              eventType: parsed.data.inferred_event_type as string,
              region: parsed.data.inferred_region,
              category: n.categoryContext ?? n.name,
              item: n.categoryContext ? n.name : undefined,
              amountMin: n.amount,
              amountMax: n.amount,
              // A single household's spending isn't a market survey — always
              // low, regardless of how confident the extraction itself was.
              confidence: 0.3,
              observedAt: new Date(),
            })),
          );
        } catch (err) {
          this.logger.warn(
            `Budget-knowledge ingestion skipped for document ${documentId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return { documentId, status: DocumentStatus.REQUIRES_REVIEW, proposedItems };
    } catch (err) {
      return this.fail(eventId, documentId, err);
    }
  }

  private async processContributionList(
    eventId: string,
    documentId: string,
    doc: LoadedDoc,
  ): Promise<ExtractionResult> {
    try {
      if (!doc.uploadedById) {
        throw new Error('Document has no uploader — cannot resolve who is staging these entries');
      }
      // The same actor/event context a live chat request would carry — the
      // uploader IS the one "typing" these entries, just via a photo instead
      // of a keyboard.
      const eventContext = await this.membership.requireContext(
        { userId: doc.uploadedById, phoneVerified: true },
        eventId,
      );
      const ctx = { actor: { userId: doc.uploadedById, phoneVerified: true }, event: eventContext };

      const file = await this.files.readBytes(eventId, doc.fileId);

      const result = await this.llm.complete({
        messages: [
          { role: 'system', content: CONTRIBUTION_EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: 'Extract the contributor/pledge entries from the attached document.' },
        ],
        tools: [{ ...EXTRACT_CONTRIBUTIONS_TOOL, parameters: { ...EXTRACT_CONTRIBUTIONS_TOOL.parameters } }],
        attachments: [{ mimeType: file.mimeType, data: file.body }],
        temperature: 0,
        toolChoice: 'required',
      });

      await this.meter.recordLlmCall(eventId, result.usage, costMicroUsd(result.usage), {
        kind: 'document_extraction',
        documentId,
      });

      const raw = result.toolCalls.find((c) => c.name === EXTRACT_CONTRIBUTIONS_TOOL.name);
      const parsed = extractContributionsResult.safeParse(raw?.arguments ?? {});
      const entries = parsed.success ? parsed.data.entries : [];

      await this.tenant.runInEvent(eventId, (tx) =>
        tx.extraction.create({
          data: {
            eventId,
            documentId,
            kind: 'CONTRIBUTION_LIST',
            structured: { entries, notes: parsed.success ? parsed.data.notes : undefined } as unknown as Prisma.InputJsonValue,
            model: result.usage.model,
            itemCount: entries.length,
          },
        }),
      );

      // Stage each entry through the EXACT SAME pipeline a human typing in
      // chat uses (tier1/tier2 parse → entity resolution → stage). No
      // bespoke resolution/StoredAction logic here — an utterance built from
      // a scanned row and one typed by a human are indistinguishable to
      // CaptureService, which is the point: identical staging, identical
      // ambiguous-name handling, identical confirm flow the frontend already
      // renders as ActionPreview cards.
      let staged = 0;
      // Track skip reasons separately so the final error message is accurate.
      let duplicates = 0;   // already recorded — "A payment of X was already recorded"
      let clarifications = 0; // ambiguous — needs human to pick a pledge
      let unreadable = 0;   // buildUtterance returned null (no name/amount)
      let otherSkipped = 0; // any other capture outcome

      for (const entry of entries) {
        const utterance = buildUtterance(entry);
        if (!utterance) {
          unreadable++;
          continue;
        }
        try {
          const captured = await this.capture.capture(ctx, utterance);
          if (captured.type === 'pending') {
            staged++;
          } else if (captured.type === 'clarification') {
            clarifications++;
            this.logger.warn(
              `Contribution-list entry not staged for document ${documentId} ("${entry.name}"): ${captured.type} — ${captured.message}`,
            );
          } else {
            // 'executed' or any other non-pending type — check if it's a duplicate
            const isDuplicate =
              typeof captured.message === 'string' &&
              captured.message.toLowerCase().includes('already recorded');
            if (isDuplicate) {
              duplicates++;
            } else {
              otherSkipped++;
            }
            this.logger.warn(
              `Contribution-list entry not staged for document ${documentId} ("${entry.name}"): ${captured.type} — ${captured.message}`,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isDuplicate = msg.toLowerCase().includes('already recorded');
          if (isDuplicate) {
            duplicates++;
          } else {
            otherSkipped++;
          }
          this.logger.warn(
            `Contribution-list entry failed for document ${documentId} ("${entry.name}"): ${msg}`,
          );
        }
      }

      const totalSkipped = duplicates + clarifications + unreadable + otherSkipped;

      // Build an accurate error/status based on WHY nothing staged.
      //   - All duplicates  → FAILED + "already recorded" message (not a new failure)
      //   - All/some clarifications with nothing staged → REQUIRES_REVIEW (human must pick)
      //   - Genuinely unreadable → FAILED + unreadable message
      let finalStatus: DocumentStatus;
      let finalError: string | null = null;

      if (staged > 0) {
        finalStatus = DocumentStatus.REQUIRES_REVIEW;
      } else if (clarifications > 0) {
        // Nothing staged but there are clarification requests — needs human attention.
        finalStatus = DocumentStatus.REQUIRES_REVIEW;
        finalError =
          `${clarifications} contribution${clarifications > 1 ? 's' : ''} need clarification` +
          (duplicates > 0 ? `; ${duplicates} already recorded` : '') +
          '. Open the chat to answer the pending questions.';
      } else if (duplicates > 0 && unreadable === 0 && otherSkipped === 0) {
        // Every entry was already recorded — this document was processed before.
        finalStatus = DocumentStatus.FAILED;
        finalError = `All ${duplicates} contribution${duplicates > 1 ? 's' : ''} in this document were already recorded. Upload a different photo or check your contributions list.`;
      } else if (unreadable === entries.length) {
        // Gemini read 0 usable rows — genuinely illegible.
        finalStatus = DocumentStatus.FAILED;
        finalError = 'No contributions could be read from this document. Try a clearer photo with better lighting.';
      } else {
        // Mixed failures with nothing staged.
        const parts: string[] = [];
        if (duplicates > 0) parts.push(`${duplicates} already recorded`);
        if (clarifications > 0) parts.push(`${clarifications} need clarification`);
        if (unreadable > 0) parts.push(`${unreadable} unreadable`);
        if (otherSkipped > 0) parts.push(`${otherSkipped} could not be processed`);
        finalStatus = DocumentStatus.FAILED;
        finalError = `No contributions were staged: ${parts.join(', ')}.`;
      }

      await this.tenant.runInEvent(eventId, (tx) =>
        tx.document.update({
          where: { id: documentId },
          data: {
            status: finalStatus,
            processedAt: new Date(),
            error: finalError,
          },
        }),
      );

      this.logger.log(
        `Contribution-list extraction for document ${documentId}: ${entries.length} read, ${staged} staged, ${totalSkipped} skipped (${duplicates} dup, ${clarifications} clarify, ${unreadable} unreadable, ${otherSkipped} other)`,
      );

      return {
        documentId,
        status: finalStatus,
        proposedItems: staged,
      };
    } catch (err) {
      return this.fail(eventId, documentId, err);
    }
  }

  private async fail(eventId: string, documentId: string, err: unknown): Promise<ExtractionResult> {
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

/**
 * Turns one extracted row into the same shape of sentence a human would type
 * in chat — CaptureService's tier1/tier2 parsing does the rest. Returns null
 * for an entry too thin to act on (no amount AND no in-kind description).
 */
function buildUtterance(entry: ExtractedContributionEntry): string | null {
  const verb = entry.status === 'paid' ? 'paid' : entry.status === 'pledged' ? 'pledged' : 'gave';
  if (entry.type === 'cash') {
    if (!entry.amount) return null;
    return `${entry.name} ${verb === 'gave' ? 'paid' : verb} ${entry.amount}`;
  }
  // item / service
  if (!entry.description) return entry.amount ? `${entry.name} ${verb === 'gave' ? 'paid' : verb} ${entry.amount}` : null;
  const what = entry.quantity ? `${entry.quantity}${entry.unit ? ` ${entry.unit}` : ''} of ${entry.description}` : entry.description;
  return `${entry.name} ${verb} ${what}`;
}
