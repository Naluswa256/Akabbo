import { Test, TestingModule } from '@nestjs/testing';
import {
  BudgetKnowledgeExtractionMethod,
  BudgetKnowledgeReliability,
  BudgetKnowledgeSourceType,
} from '@prisma/client';
import { AppConfigModule } from '@akabbo/config';
import { PrismaModule, PrismaService } from '@akabbo/prisma';
import {
  LLM_PROVIDER,
  LlmCompletionRequest,
  LlmCompletionResult,
  ProvidersModule,
  SEARCH_PROVIDER,
  SearchOptions,
  SearchProvider,
  SearchResult,
} from '@akabbo/providers';
import { BudgetIntelligenceModule, BudgetKnowledgeService } from '@akabbo/budget-intelligence';

/** Fully controllable search double — no network calls in the normal suite. */
class MockSearchProvider implements SearchProvider {
  readonly name = 'mock';
  queued: SearchResult[] = [];
  lastQuery: string | null = null;
  search(query: string, _options?: SearchOptions): Promise<SearchResult[]> {
    this.lastQuery = query;
    return Promise.resolve(this.queued);
  }
}

/** Fully controllable extraction double — mirrors MockMultimodalLlm in
 *  documents.integration.spec.ts, one level up (knowledge, not per-event). */
class MockExtractionLlm {
  readonly name = 'mock-extraction';
  next: LlmCompletionResult | null = null;
  lastRequest: LlmCompletionRequest | null = null;
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    this.lastRequest = req;
    if (!this.next) throw new Error('MockExtractionLlm has no queued response');
    return Promise.resolve(this.next);
  }
  queueObservations(eventType: string, observations: Record<string, unknown>[]): void {
    this.next = {
      toolCalls: [{ name: 'extract_knowledge', arguments: { eventType, observations } }],
      usage: { inputTokens: 500, outputTokens: 100, model: 'mock' },
    };
  }
}

describe('Budget intelligence — pre-budgeting (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let service: BudgetKnowledgeService;
  const search = new MockSearchProvider();
  const llm = new MockExtractionLlm();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, ProvidersModule, BudgetIntelligenceModule],
    })
      .overrideProvider(SEARCH_PROVIDER)
      .useValue(search)
      .overrideProvider(LLM_PROVIDER)
      .useValue(llm)
      .compile();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(BudgetKnowledgeService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE budget_knowledge_observation, budget_knowledge_source RESTART IDENTITY CASCADE',
    );
    search.queued = [];
    search.lastQuery = null;
    llm.next = null;
  });

  it('seeds real curated data and aggregates without double-counting the reference totals', async () => {
    await service.onModuleInit(); // idempotent — triggers seedIfEmpty()

    const result = await service.getRecommendation({ eventType: 'wedding' });

    expect(result.status).toBe('resolved');
    const catering = result.categories.find((c) => c.category === 'Catering');
    expect(catering?.amountMin).toBe('15000');
    expect(catering?.amountMax).toBe('100000'); // spans the budget..premium seed rows

    // The seeded "Total (…)" reference rows (12-15M / 38-42M / 94-104M) must
    // never feed the summed totalRange — only real line-item categories may.
    expect(result.totalRange).not.toBeNull();
    if (result.totalRange) {
      expect(BigInt(result.totalRange.max)).toBeLessThan(50_000_000n);
    }
    expect(result.possiblyMissing.length).toBeGreaterThan(0); // seeded commonlyForgotten rows
  });

  it('gap-detection excludes categories the organizer already has', async () => {
    await service.onModuleInit();
    const result = await service.getRecommendation({
      eventType: 'wedding',
      existingCategories: ['Delegation attire', 'Day-of tips'],
    });
    expect(result.possiblyMissing).not.toContain('Delegation attire');
    expect(result.possiblyMissing).not.toContain('Day-of tips');
  });

  it('backfills via search when coverage is thin, skips blocked domains, and respects the cooldown', async () => {
    search.queued = [
      { title: 'Blocked', url: 'https://www.scribd.com/document/1', snippet: 'x' },
      {
        title: 'Real guide',
        url: 'https://example.com/church-fundraiser-budget',
        snippet: 'Catering for church fundraisers typically costs 20,000-30,000 per plate.',
        content: 'Catering for church fundraisers typically costs 20,000-30,000 per plate.',
      },
    ];
    llm.queueObservations('church_fundraiser', [
      {
        category: 'Catering',
        amountMin: '20000',
        amountMax: '30000',
        unit: 'per_plate',
        confidence: 0.7,
      },
    ]);

    const result = await service.getRecommendation({ eventType: 'church_fundraiser' });
    expect(result.status).toBe('resolved');
    expect(search.lastQuery).toContain('church_fundraiser');

    const sources = await prisma.budgetKnowledgeSource.findMany();
    expect(sources.some((s) => s.url?.includes('scribd.com'))).toBe(false);
    expect(sources.some((s) => s.url?.includes('example.com'))).toBe(true);

    // Second call within the cooldown window must not search again — the
    // topic itself is the cache key (§7 of the exploration doc).
    const beforeCount = await prisma.budgetKnowledgeSource.count();
    await service.getRecommendation({ eventType: 'church_fundraiser' });
    const afterCount = await prisma.budgetKnowledgeSource.count();
    expect(afterCount).toBe(beforeCount);
  });

  it('reports no_data honestly instead of a guessed range when nothing is found', async () => {
    search.queued = [];
    const result = await service.getRecommendation({
      eventType: 'some totally unheard of event type',
    });
    expect(result.status).toBe('no_data');
    expect(result.categories).toEqual([]);
    expect(result.totalRange).toBeNull();
  });

  it('ingestObservations round-trips a manual source (the curated-seed / user-upload path)', async () => {
    const { sourceId, count } = await service.ingestObservations(
      {
        sourceType: BudgetKnowledgeSourceType.manual_entry,
        name: 'test-manual-source',
        reliability: BudgetKnowledgeReliability.HIGH,
        licensingNote: 'test',
        extractionMethod: BudgetKnowledgeExtractionMethod.manual,
      },
      [
        {
          eventType: 'funeral',
          category: 'Coffin',
          amountMin: 500_000n,
          amountMax: 2_000_000n,
          confidence: 0.8,
          observedAt: new Date(),
        },
      ],
    );
    expect(count).toBe(1);
    const stored = await prisma.budgetKnowledgeObservation.findMany({ where: { sourceId } });
    expect(stored).toHaveLength(1);
    expect(stored[0].category).toBe('Coffin');
  });

  it('admin document upload creates a HIGH-reliability admin_upload source, original file preserved', async () => {
    llm.queueObservations('graduation', [
      { category: 'Venue', amountMin: '1000000', amountMax: '2000000', confidence: 0.8 },
    ]);
    const result = await service.ingestFromDocument({
      filename: 'sample-budget.csv',
      mimeType: 'text/csv',
      data: Buffer.from('Item,Amount\nVenue,1500000\n'),
      eventTypeHint: 'graduation',
      note: 'Shared directly by a real family, with permission',
    });
    expect(result.eventType).toBe('graduation');
    expect(result.observationCount).toBe(1);

    const source = await prisma.budgetKnowledgeSource.findUniqueOrThrow({
      where: { id: result.sourceId },
    });
    expect(source.sourceType).toBe(BudgetKnowledgeSourceType.admin_upload);
    expect(source.reliability).toBe(BudgetKnowledgeReliability.HIGH);
    expect(source.originalFilename).toBe('sample-budget.csv');
    expect(source.storageKey).toBeTruthy();
  });

  it('admin-uploaded (HIGH reliability) rows take priority over lower-reliability rows for the same category', async () => {
    // A lower-trust, implausibly wide range first (e.g. from a live search).
    await service.ingestObservations(
      {
        sourceType: BudgetKnowledgeSourceType.public_article,
        name: 'low-trust-source',
        reliability: BudgetKnowledgeReliability.LOW,
        licensingNote: 'test',
        extractionMethod: BudgetKnowledgeExtractionMethod.ai_extraction_live,
      },
      [
        {
          eventType: 'graduation',
          category: 'Venue',
          amountMin: 500_000n,
          amountMax: 20_000_000n,
          confidence: 0.3,
          observedAt: new Date(),
        },
      ],
    );
    // Then a real, admin-vetted document with a tighter, trustworthy range.
    llm.queueObservations('graduation', [
      { category: 'Venue', amountMin: '1000000', amountMax: '1500000', confidence: 0.8 },
    ]);
    await service.ingestFromDocument({
      filename: 'real-family-budget.csv',
      mimeType: 'text/csv',
      data: Buffer.from('Item,Amount\nVenue,1200000\n'),
      eventTypeHint: 'graduation',
    });

    const result = await service.getRecommendation({ eventType: 'graduation' });
    const venue = result.categories.find((c) => c.category === 'Venue');
    // Must reflect ONLY the admin-uploaded range, not the wide low-trust one.
    expect(venue?.amountMin).toBe('1000000');
    expect(venue?.amountMax).toBe('1500000');
    expect(venue?.confidence).toBe('high');
  });

  it('rejects an unsupported file type before touching storage or the model', async () => {
    await expect(
      service.ingestFromDocument({
        filename: 'weird.exe',
        mimeType: 'application/octet-stream',
        data: Buffer.from('x'),
      }),
    ).rejects.toThrow('Unsupported file type');
  });

  it('genuinely parses a real xlsx buffer — the extracted cell values reach the model, not a placeholder', async () => {
    const XLSX = await import('xlsx');
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Item', 'Amount'],
      ['Catering', 2_500_000],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Budget');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    llm.queueObservations('wedding', [
      { category: 'Catering', amountMin: '2500000', amountMax: '2500000', confidence: 0.75 },
    ]);
    const result = await service.ingestFromDocument({
      filename: 'real.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: buffer,
      eventTypeHint: 'wedding',
    });
    expect(result.observationCount).toBe(1);
    const sentContent = llm.lastRequest?.messages.map((m) => m.content).join('\n') ?? '';
    expect(sentContent).toContain('2500000');
    expect(sentContent).toContain('Catering');
  });

  it('genuinely parses a real docx buffer — mammoth actually reads it, not a placeholder', async () => {
    // Built with the `docx` writer (devDependency, test-only) rather than a
    // hand-rolled fake buffer, so this exercises real OOXML round-tripping
    // through mammoth, the same way the xlsx test above does for SheetJS.
    const { Document, Paragraph, TextRun, Packer } = await import('docx');
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ children: [new TextRun('Kwanjula Budget')] }),
            new Paragraph({ children: [new TextRun('Catering: 2,500,000 UGX')] }),
          ],
        },
      ],
    });
    const buffer = await Packer.toBuffer(doc);

    llm.queueObservations('kwanjula', [
      { category: 'Catering', amountMin: '2500000', amountMax: '2500000', confidence: 0.75 },
    ]);
    const result = await service.ingestFromDocument({
      filename: 'real.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data: buffer,
      eventTypeHint: 'kwanjula',
    });
    expect(result.observationCount).toBe(1);
    const sentContent = llm.lastRequest?.messages.map((m) => m.content).join('\n') ?? '';
    expect(sentContent).toContain('2,500,000');
    expect(sentContent).toContain('Catering');
  });

  it('lists recent sources for the admin panel, newest first, optionally filtered', async () => {
    await service.ingestObservations(
      {
        sourceType: BudgetKnowledgeSourceType.manual_entry,
        name: 'list-test-source',
        reliability: BudgetKnowledgeReliability.MEDIUM,
        licensingNote: 'test',
        extractionMethod: BudgetKnowledgeExtractionMethod.manual,
      },
      [],
    );
    const all = await service.listSources({});
    expect(all.some((s) => s.name === 'list-test-source')).toBe(true);

    const filtered = await service.listSources({ sourceType: BudgetKnowledgeSourceType.admin_upload });
    expect(filtered.every((s) => s.sourceType === BudgetKnowledgeSourceType.admin_upload)).toBe(true);
  });
});
