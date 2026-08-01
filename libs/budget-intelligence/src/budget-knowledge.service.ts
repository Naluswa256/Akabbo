import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '@akabbo/prisma';
import {
  LLM_PROVIDER,
  LlmProvider,
  SEARCH_PROVIDER,
  SearchProvider,
  SearchResult,
  STORAGE_PROVIDER,
  StorageProvider,
} from '@akabbo/providers';
import {
  BudgetKnowledgeExtractionMethod,
  BudgetKnowledgeReliability,
  BudgetKnowledgeSourceType,
  BudgetTier,
} from '@prisma/client';
import { isBlockedSource } from './domain-blocklist';
import { extractText, isSupportedKnowledgeUpload, isTextExtractable } from './document-text';
import {
  EXTRACT_KNOWLEDGE_TOOL,
  KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT,
  extractKnowledgeResult,
} from './knowledge-extraction-contract';
import { SEED_DATA } from './seed-data';

/** Don't re-search the same topic more often than this — the topic itself is
 *  the cache key (§7 of the pre-budgeting exploration: "embedded and
 *  automatic" without being "once per message"). */
const LIVE_SEARCH_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** Observations older than this are excluded from a recommendation outright
 *  — UGX is a cash economy, a 2-year-old price is a different question. */
const STALE_AFTER_MS = 24 * 30 * 24 * 60 * 60 * 1000;
/** Below this many distinct categories, treat the knowledge base as too thin
 *  to trust over a fresh search rather than as "no data at all". */
const MIN_CATEGORIES_FOR_COVERAGE = 3;

export interface BudgetRecommendationInput {
  eventType: string;
  region?: string;
  guestCount?: number;
  tier?: 'budget' | 'mid' | 'premium';
  /** Categories the organizer already has, for gap-detection — folded into
   *  this one tool rather than a second tool (§5 of the exploration). */
  existingCategories?: string[];
}

export interface BudgetRecommendationCategory {
  category: string;
  amountMin: string | null;
  amountMax: string | null;
  unit: string | null;
  confidence: 'low' | 'medium' | 'high';
  sourceCount: number;
  commonlyForgotten: boolean;
}

export interface BudgetRecommendationResult {
  status: 'resolved' | 'no_data';
  eventType: string;
  region: string | null;
  tier: string | null;
  categories: BudgetRecommendationCategory[];
  totalRange: { min: string; max: string } | null;
  possiblyMissing: string[];
  regionalNote: string | null;
  /** Coarse "as of" (YYYY-MM) — never a false-precise day, per the never
   *  claim a verified current price rule. */
  asOf: string | null;
}

export interface KnowledgeSourceInput {
  sourceType: BudgetKnowledgeSourceType;
  name: string;
  url?: string;
  publishedAt?: Date;
  reliability: BudgetKnowledgeReliability;
  licensingNote: string;
  extractionMethod: BudgetKnowledgeExtractionMethod;
  /** admin_upload only — see ingestFromDocument. */
  storageKey?: string;
  originalFilename?: string;
  mimeType?: string;
}

export interface KnowledgeObservationInput {
  eventType: string;
  region?: string;
  tier?: BudgetTier;
  category: string;
  item?: string;
  amountMin?: bigint;
  amountMax?: bigint;
  unit?: string;
  commonlyForgotten?: boolean;
  confidence: number;
  observedAt: Date;
}

interface ObservationRow {
  category: string;
  item: string | null;
  region: string | null;
  amountMin: bigint | null;
  amountMax: bigint | null;
  unit: string | null;
  commonlyForgotten: boolean;
  confidence: number;
  sourceId: string;
  observedAt: Date;
  /** The owning source's reliability — carried through so a category with
   *  both an admin-vetted row and a live-search row can prioritize the
   *  former (see aggregateByCategory), not just average them together. */
  reliability: BudgetKnowledgeReliability;
}

/**
 * Budget-intelligence recommendations (pre-budgeting). Deliberately NOT
 * tenant-scoped — this is global reference data (BudgetKnowledgeSource /
 * BudgetKnowledgeObservation carry no event_id), so, unlike every ledger
 * service, there is no TenantContext/RLS transaction here — a plain
 * PrismaService query is the whole story.
 *
 * "Never let the model invent a number" (blueprint §9) applies here exactly
 * as it does everywhere else: every range returned is aggregated in code
 * from stored rows, never phrased or computed by the LLM.
 */
@Injectable()
export class BudgetKnowledgeService implements OnModuleInit {
  private readonly logger = new Logger(BudgetKnowledgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SEARCH_PROVIDER) private readonly search: SearchProvider,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /** Mirrors AssistantService's onModuleInit seeding of learned exemplars —
   *  idempotent, non-fatal on failure (the app must still boot). */
  async onModuleInit(): Promise<void> {
    try {
      await this.seedIfEmpty();
    } catch (err) {
      this.logger.warn(
        `Budget-knowledge seed skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async seedIfEmpty(): Promise<void> {
    const already = await this.prisma.budgetKnowledgeSource.findFirst({
      where: { sourceType: BudgetKnowledgeSourceType.public_article, extractionMethod: BudgetKnowledgeExtractionMethod.manual },
      select: { id: true },
    });
    if (already) return;
    for (const { source, observations } of SEED_DATA) {
      await this.ingestObservations(source, observations);
    }
    this.logger.log(`Seeded ${SEED_DATA.length} curated budget-knowledge source(s)`);
  }

  async getRecommendation(input: BudgetRecommendationInput): Promise<BudgetRecommendationResult> {
    const eventType = normalize(input.eventType);
    const region = input.region ? normalize(input.region) : undefined;

    let rows = await this.queryObservations(eventType, region, input.tier);
    if (!hasUsableCoverage(rows)) {
      await this.maybeBackfillLive(eventType);
      rows = await this.queryObservations(eventType, region, input.tier);
    }

    if (rows.length === 0) {
      return {
        status: 'no_data',
        eventType,
        region: region ?? null,
        tier: input.tier ?? null,
        categories: [],
        totalRange: null,
        possiblyMissing: [],
        regionalNote: null,
        asOf: null,
      };
    }

    const priced = rows.filter((r) => r.amountMin !== null || r.amountMax !== null);
    const categories = aggregateByCategory(priced);

    const existing = new Set((input.existingCategories ?? []).map(normalize));
    const possiblyMissing = Array.from(
      new Set(
        rows.filter((r) => r.commonlyForgotten && !existing.has(normalize(r.category))).map((r) => r.category),
      ),
    );

    // Whole-event reference figures (a source's own stated ballpark, seeded
    // with the "Total (…)" category prefix) are shown to the user like any
    // other category but must NOT be summed alongside real line items —
    // that would double-count everything the total already includes.
    let totalMin = 0n;
    let totalMax = 0n;
    let hasTotal = false;
    for (const c of categories) {
      if (c.amountMin !== null && c.amountMax !== null && !c.category.startsWith('Total (')) {
        totalMin += BigInt(c.amountMin);
        totalMax += BigInt(c.amountMax);
        hasTotal = true;
      }
    }

    const usedRegionRows = region ? rows.some((r) => r.region === region) : false;
    const regionalNote =
      region && !usedRegionRows
        ? 'No region-specific data for this area yet — showing the Uganda-wide/Kampala-anchored baseline. Published guides suggest costs outside Kampala tend to run roughly 20-40% lower.'
        : null;

    const mostRecent = rows.reduce<Date | null>(
      (latest, r) => (!latest || r.observedAt > latest ? r.observedAt : latest),
      null,
    );

    return {
      status: 'resolved',
      eventType,
      region: region ?? null,
      tier: input.tier ?? null,
      categories,
      totalRange: hasTotal ? { min: totalMin.toString(), max: totalMax.toString() } : null,
      possiblyMissing,
      regionalNote,
      asOf: mostRecent ? mostRecent.toISOString().slice(0, 7) : null,
    };
  }

  /**
   * Used by the curated-seed data and by user-upload extraction (BUDGET-kind
   * documents only — see libs/documents ExtractionService) to write into the
   * shared table. One method, two callers, same shape as every other
   * observation regardless of where it came from.
   */
  async ingestObservations(
    source: KnowledgeSourceInput,
    observations: KnowledgeObservationInput[],
  ): Promise<{ sourceId: string; count: number }> {
    const created = await this.prisma.budgetKnowledgeSource.create({ data: source });
    if (observations.length > 0) {
      await this.prisma.budgetKnowledgeObservation.createMany({
        data: observations.map((o) => ({
          sourceId: created.id,
          eventType: normalize(o.eventType),
          region: o.region ? normalize(o.region) : null,
          tier: o.tier ?? null,
          category: o.category,
          item: o.item ?? null,
          amountMin: o.amountMin ?? null,
          amountMax: o.amountMax ?? null,
          unit: o.unit ?? null,
          commonlyForgotten: o.commonlyForgotten ?? false,
          confidence: o.confidence,
          observedAt: o.observedAt,
        })),
      });
    }
    return { sourceId: created.id, count: observations.length };
  }

  /**
   * Admin-only path (see AdminBudgetKnowledgeController): a Word doc, Excel
   * sheet, or screenshot/PDF of a REAL person's real budget, deliberately
   * sourced and vetted by an admin — not scraped, not incidental. Written as
   * `admin_upload` / HIGH reliability, which is what makes it take priority
   * over other sources for the same category in getRecommendation. The
   * original file is preserved in storage the same way a per-event
   * Document's original is — the extraction is a derived projection, never
   * a replacement.
   */
  async ingestFromDocument(input: {
    filename: string;
    mimeType: string;
    data: Buffer;
    eventTypeHint?: string;
    regionHint?: string;
    note?: string;
  }): Promise<{ sourceId: string; eventType: string; observationCount: number }> {
    if (!isSupportedKnowledgeUpload(input.mimeType)) {
      throw new BadRequestException(`Unsupported file type: ${input.mimeType}`);
    }

    const storageKey = `budget-knowledge/admin/${randomUUID()}-${input.filename}`;
    await this.storage.putObject({
      key: storageKey,
      body: input.data,
      contentType: input.mimeType,
    });

    const hintSuffix = input.eventTypeHint
      ? ` (admin says this is a ${input.eventTypeHint} budget${input.regionHint ? ` from ${input.regionHint}` : ''})`
      : '';
    const tools = [{ ...EXTRACT_KNOWLEDGE_TOOL, parameters: { ...EXTRACT_KNOWLEDGE_TOOL.parameters } }];

    const completion = isTextExtractable(input.mimeType)
      ? await this.llm.complete({
          messages: [
            { role: 'system', content: KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT },
            {
              role: 'user',
              content: `Source: ${input.filename}${hintSuffix}\n\n${(await extractText(input.mimeType, input.data)).slice(0, 20_000)}`,
            },
          ],
          tools,
          temperature: 0,
          toolChoice: 'required',
        })
      : await this.llm.complete({
          messages: [
            { role: 'system', content: KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT },
            { role: 'user', content: `Extract budget knowledge from the attached document.${hintSuffix}` },
          ],
          tools,
          attachments: [{ mimeType: input.mimeType, data: input.data, filename: input.filename }],
          temperature: 0,
          toolChoice: 'required',
        });

    const call = completion.toolCalls.find((c) => c.name === EXTRACT_KNOWLEDGE_TOOL.name);
    const parsed = extractKnowledgeResult.safeParse(call?.arguments ?? {});
    const eventType = input.eventTypeHint || (parsed.success ? parsed.data.eventType : undefined);
    if (!eventType) {
      throw new BadRequestException(
        'Could not determine an event type for this document — pass eventTypeHint explicitly.',
      );
    }
    const observations = parsed.success ? parsed.data.observations : [];

    const { sourceId, count } = await this.ingestObservations(
      {
        sourceType: BudgetKnowledgeSourceType.admin_upload,
        name: `admin-upload:${input.filename}`,
        reliability: BudgetKnowledgeReliability.HIGH,
        licensingNote:
          (input.note ? `${input.note} — ` : '') +
          'Admin-vetted upload of a real budget, sourced directly and reviewed before entry — never scraped.',
        extractionMethod: BudgetKnowledgeExtractionMethod.ai_extraction_reviewed,
        storageKey,
        originalFilename: input.filename,
        mimeType: input.mimeType,
      },
      observations.map((o) => ({
        eventType,
        region: input.regionHint || o.region,
        tier: o.tier as BudgetTier | undefined,
        category: o.category,
        item: o.item,
        amountMin: o.amountMin ? BigInt(o.amountMin) : undefined,
        amountMax: o.amountMax ? BigInt(o.amountMax) : undefined,
        unit: o.unit,
        commonlyForgotten: o.commonlyForgotten,
        // A real, admin-vetted document reads as more trustworthy than an
        // unreviewed web page, but it's still an LLM's read of a document —
        // never let it claim full certainty.
        confidence: Math.min(o.confidence + 0.15, 0.9),
        observedAt: new Date(),
      })),
    );

    this.logger.log(
      `Admin knowledge upload "${input.filename}": eventType=${eventType} observations=${count}`,
    );
    return { sourceId, eventType, observationCount: count };
  }

  /** For the admin panel: browse what's already in the knowledge base,
   *  newest first, optionally filtered — the read side of ingestFromDocument
   *  / the live-search and curated-seed paths, so an admin can see the full
   *  picture rather than uploading into a void. */
  async listSources(filter: {
    sourceType?: BudgetKnowledgeSourceType;
    eventType?: string;
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      sourceType: BudgetKnowledgeSourceType;
      name: string;
      url: string | null;
      reliability: BudgetKnowledgeReliability;
      extractionMethod: BudgetKnowledgeExtractionMethod;
      originalFilename: string | null;
      mimeType: string | null;
      collectedAt: Date;
      observationCount: number;
    }>
  > {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const sources = await this.prisma.budgetKnowledgeSource.findMany({
      where: {
        ...(filter.sourceType ? { sourceType: filter.sourceType } : {}),
        ...(filter.eventType
          ? { observations: { some: { eventType: normalize(filter.eventType) } } }
          : {}),
      },
      orderBy: { collectedAt: 'desc' },
      take: limit,
      include: { _count: { select: { observations: true } } },
    });
    return sources.map((s) => ({
      id: s.id,
      sourceType: s.sourceType,
      name: s.name,
      url: s.url,
      reliability: s.reliability,
      extractionMethod: s.extractionMethod,
      originalFilename: s.originalFilename,
      mimeType: s.mimeType,
      collectedAt: s.collectedAt,
      observationCount: s._count.observations,
    }));
  }

  private async queryObservations(
    eventType: string,
    region: string | undefined,
    tier: string | undefined,
  ): Promise<ObservationRow[]> {
    const cutoff = new Date(Date.now() - STALE_AFTER_MS);
    const rows = await this.prisma.budgetKnowledgeObservation.findMany({
      where: {
        eventType,
        observedAt: { gte: cutoff },
        ...(tier ? { OR: [{ tier: tier as BudgetTier }, { tier: null }] } : {}),
      },
      include: { source: { select: { reliability: true } } },
    });
    const all: ObservationRow[] = rows.map((r) => ({
      category: r.category,
      item: r.item,
      region: r.region,
      amountMin: r.amountMin,
      amountMax: r.amountMax,
      unit: r.unit,
      commonlyForgotten: r.commonlyForgotten,
      confidence: r.confidence,
      sourceId: r.sourceId,
      observedAt: r.observedAt,
      reliability: r.source.reliability,
    }));
    const baseline = all.filter((r) => !r.region);
    if (!region) return baseline;
    const regional = all.filter((r) => r.region && r.region === region);
    return regional.length > 0 ? [...regional, ...baseline] : baseline;
  }

  /** Demand-driven backfill: fires automatically when coverage is thin,
   *  never on a schedule and never twice for the same topic within the
   *  cooldown window regardless of how thin the result turns out to be —
   *  that's what keeps this a bounded cost, not an unbounded one (§7). */
  private async maybeBackfillLive(eventType: string): Promise<void> {
    const attemptKey = `live-search:${eventType}`;
    const cooldownCutoff = new Date(Date.now() - LIVE_SEARCH_COOLDOWN_MS);
    // A successful attempt writes one source per result, named
    // `${attemptKey}:${host}` (see ingestLiveResult); a zero-result attempt
    // writes exactly one, named `${attemptKey}` (see recordSearchAttempt).
    // The cooldown has to match either shape, so it's a prefix match, not an
    // exact one — an exact match here would only ever catch the zero-result
    // case and silently re-search every single time a search had actually
    // succeeded, which is the opposite of what the cooldown is for.
    const recent = await this.prisma.budgetKnowledgeSource.findFirst({
      where: {
        name: { startsWith: attemptKey },
        extractionMethod: BudgetKnowledgeExtractionMethod.ai_extraction_live,
        collectedAt: { gte: cooldownCutoff },
      },
    });
    if (recent) return;

    let results: SearchResult[];
    try {
      results = await this.search.search(`${eventType} budget cost Uganda`, { maxResults: 5 });
    } catch (err) {
      this.logger.warn(
        `Live budget search failed for "${eventType}": ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.recordSearchAttempt(attemptKey, 0);
      return;
    }

    const allowed = results.filter((r) => !isBlockedSource(r.url));
    this.logger.log(
      `Live budget search "${eventType}": ${results.length} result(s), ${allowed.length} after domain blocklist`,
    );

    let ingested = 0;
    for (const result of allowed) {
      try {
        ingested += await this.ingestLiveResult(eventType, attemptKey, result);
      } catch (err) {
        this.logger.warn(
          `Knowledge extraction failed for ${result.url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (ingested === 0) await this.recordSearchAttempt(attemptKey, 0);
  }

  private async recordSearchAttempt(attemptKey: string, observationCount: number): Promise<void> {
    await this.prisma.budgetKnowledgeSource.create({
      data: {
        sourceType: BudgetKnowledgeSourceType.public_article,
        name: attemptKey,
        reliability: BudgetKnowledgeReliability.LOW,
        licensingNote: `Live search attempt (${observationCount} observation(s) ingested) — domain-blocklist enforced, Scribd/Slideshare/Everand excluded.`,
        extractionMethod: BudgetKnowledgeExtractionMethod.ai_extraction_live,
      },
    });
  }

  private async ingestLiveResult(
    eventType: string,
    attemptKey: string,
    result: SearchResult,
  ): Promise<number> {
    const text = (result.content && result.content.slice(0, 8000)) || result.snippet;
    if (!text) return 0;

    const completion = await this.llm.complete({
      messages: [
        { role: 'system', content: KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: `Source: ${result.title} (${result.url})\n\n${text}` },
      ],
      tools: [{ ...EXTRACT_KNOWLEDGE_TOOL, parameters: { ...EXTRACT_KNOWLEDGE_TOOL.parameters } }],
      temperature: 0,
      toolChoice: 'required',
    });

    const call = completion.toolCalls.find((c) => c.name === EXTRACT_KNOWLEDGE_TOOL.name);
    const parsed = extractKnowledgeResult.safeParse(call?.arguments ?? {});
    if (!parsed.success || parsed.data.observations.length === 0) return 0;

    let host = result.url;
    try {
      host = new URL(result.url).hostname;
    } catch {
      // keep the raw url as the disambiguator if it somehow isn't parseable
    }

    await this.ingestObservations(
      {
        sourceType: BudgetKnowledgeSourceType.public_article,
        name: `${attemptKey}:${host}`,
        url: result.url,
        publishedAt: result.publishedAt ? new Date(result.publishedAt) : undefined,
        reliability: BudgetKnowledgeReliability.MEDIUM,
        licensingNote:
          'Found by live search; domain-blocklist enforced before extraction. Never human-reviewed — ' +
          'the organizer who triggered the search sees and can challenge the result in the same conversation, ' +
          'which is the review, just a conversational one instead of a curator\'s.',
        extractionMethod: BudgetKnowledgeExtractionMethod.ai_extraction_live,
      },
      parsed.data.observations.map((o) => ({
        eventType: parsed.data.eventType || eventType,
        region: o.region,
        tier: o.tier as BudgetTier | undefined,
        category: o.category,
        item: o.item,
        amountMin: o.amountMin ? BigInt(o.amountMin) : undefined,
        amountMax: o.amountMax ? BigInt(o.amountMax) : undefined,
        unit: o.unit,
        commonlyForgotten: o.commonlyForgotten,
        // Live/unreviewed rows never claim more than "medium" on their own,
        // regardless of what the model reported.
        confidence: Math.min(o.confidence, 0.6),
        observedAt: result.publishedAt ? new Date(result.publishedAt) : new Date(),
      })),
    );

    this.logger.log(
      `Knowledge extraction for "${eventType}" from ${result.url}: ${parsed.data.observations.length} observation(s), ` +
        `model=${completion.usage.model}, tokens=${completion.usage.inputTokens}+${completion.usage.outputTokens}`,
    );
    return parsed.data.observations.length;
  }
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function hasUsableCoverage(rows: { category: string }[]): boolean {
  return new Set(rows.map((r) => r.category)).size >= MIN_CATEGORIES_FOR_COVERAGE;
}

function aggregateByCategory(rows: ObservationRow[]): BudgetRecommendationCategory[] {
  const byCategory = new Map<string, ObservationRow[]>();
  for (const r of rows) {
    const key = r.category;
    const bucket = byCategory.get(key);
    if (bucket) bucket.push(r);
    else byCategory.set(key, [r]);
  }

  const result: BudgetRecommendationCategory[] = [];
  for (const [category, categoryRows] of byCategory) {
    // Admin-vetted rows (a real person's real, human-reviewed budget) take
    // priority over everything else in this category — a generic blog range
    // or an unreviewed live-search snippet doesn't get to outvote a real,
    // vetted document. commonlyForgotten stays a union across ALL rows
    // regardless (that signal doesn't have the same "whose number wins"
    // problem a price range does).
    const highTrust = categoryRows.filter((r) => r.reliability === BudgetKnowledgeReliability.HIGH);
    const rowsForRange = highTrust.length > 0 ? highTrust : categoryRows;

    const mins = rowsForRange.map((r) => r.amountMin).filter((v): v is bigint => v !== null);
    const maxes = rowsForRange.map((r) => r.amountMax).filter((v): v is bigint => v !== null);
    const sourceIds = new Set(rowsForRange.map((r) => r.sourceId));
    const avgConfidence = rowsForRange.reduce((sum, r) => sum + r.confidence, 0) / rowsForRange.length;
    result.push({
      category,
      amountMin: mins.length ? minOf(mins).toString() : null,
      amountMax: maxes.length ? maxOf(maxes).toString() : null,
      unit: rowsForRange.find((r) => r.unit)?.unit ?? null,
      confidence: highTrust.length > 0 ? 'high' : confidenceLabel(avgConfidence, sourceIds.size),
      sourceCount: sourceIds.size,
      commonlyForgotten: categoryRows.some((r) => r.commonlyForgotten),
    });
  }
  return result.sort((a, b) => {
    const bMax = b.amountMax ? BigInt(b.amountMax) : 0n;
    const aMax = a.amountMax ? BigInt(a.amountMax) : 0n;
    return bMax > aMax ? 1 : bMax < aMax ? -1 : 0;
  });
}

/** A single source never reads as HIGH confidence, no matter how confident
 *  that one source was — cross-source agreement is what earns HIGH (this is
 *  the Harusi-Hub-vs-Palm-Gardens lesson from the exploration doc's own
 *  research: two real sources disagreed on scope, which is exactly why one
 *  source alone shouldn't read as settled). */
function confidenceLabel(avg: number, sourceCount: number): 'low' | 'medium' | 'high' {
  if (sourceCount <= 1) return avg >= 0.7 ? 'medium' : 'low';
  if (avg >= 0.7) return 'high';
  if (avg >= 0.4) return 'medium';
  return 'low';
}

function minOf(vals: bigint[]): bigint {
  return vals.reduce((a, b) => (b < a ? b : a));
}
function maxOf(vals: bigint[]): bigint {
  return vals.reduce((a, b) => (b > a ? b : a));
}
