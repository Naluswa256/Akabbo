import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppConfigModule } from '@akabbo/config';
import { PrismaModule, PrismaService } from '@akabbo/prisma';
import { ProvidersModule } from '@akabbo/providers';
import { BudgetIntelligenceModule, BudgetKnowledgeService } from '@akabbo/budget-intelligence';

/**
 * LIVE end-to-end test against the REAL Tavily search API + REAL Gemini —
 * proves the demand-driven live-search backfill actually works (search →
 * domain blocklist → extraction → write → aggregated read), not just that
 * the pieces typecheck. Gated on both keys so normal/CI runs stay offline,
 * mirroring live-gemini.e2e.spec.ts. Run with:
 *
 *   GEMINI_API_KEY=... SEARCH_API_KEY=... DATABASE_URL=... DIRECT_URL=... \
 *   NODE_ENV=test JWT_SECRET=... pnpm test -- test/live-budget-intelligence.e2e.spec.ts
 */
const LIVE = Boolean(process.env.GEMINI_API_KEY) && Boolean(process.env.SEARCH_API_KEY);
if (LIVE) {
  process.env.LLM_PROVIDER = 'gemini';
  process.env.GEMINI_MODEL ??= 'gemini-flash-latest';
  process.env.SEARCH_PROVIDER = 'tavily';
}

(LIVE ? describe : describe.skip)('LIVE — budget intelligence live search (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let service: BudgetKnowledgeService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, ProvidersModule, BudgetIntelligenceModule],
    }).compile();
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
  });

  it(
    'backfills from a real search when there is no existing coverage, and never ingests a blocked domain',
    async () => {
      // "church fundraiser" is deliberately absent from seed-data.ts so this
      // exercises the live-search branch, not the pre-seeded path.
      const result = await service.getRecommendation({ eventType: 'church fundraiser' });
      // eslint-disable-next-line no-console
      console.log('\n[LIVE recommendation] %o', result);

      const sources = await prisma.budgetKnowledgeSource.findMany({
        where: { name: { startsWith: 'live-search:church fundraiser' } },
      });
      // eslint-disable-next-line no-console
      console.log(
        '\n[LIVE sources] %o',
        sources.map((s) => ({ name: s.name, url: s.url, reliability: s.reliability })),
      );
      expect(sources.length).toBeGreaterThanOrEqual(1);
      // The one hard safety guarantee: whatever the search turned up, nothing
      // from a domain whose own terms prohibit this ever became a source row.
      for (const s of sources) {
        if (s.url) expect(s.url).not.toMatch(/scribd\.com|slideshare\.net|everand\.com/i);
      }
    },
    120_000,
  );

  it(
    'kwanjula live search actually extracts real observations — catches schema-level API failures, not just "a row exists"',
    async () => {
      // This is the exact gap that let a real bug ship: the earlier version
      // of this test only checked that A source row existed, which is also
      // true when every single extraction call fails with a hard API error
      // (Gemini's tools[].function_declarations[].parameters schema doesn't
      // accept `additionalProperties` — a real 400 that was being silently
      // swallowed into a "0 observations" outcome that reads identically to
      // "the source was genuinely thin"). Spying on Logger.warn makes that
      // failure mode fail this test directly instead of hiding in logs
      // nobody re-checks after the fact.
      const warnSpy = jest.spyOn(Logger.prototype, 'warn');
      const result = await service.getRecommendation({
        eventType: 'kwanjula',
        region: 'Mbale',
        guestCount: 300,
      });
      // eslint-disable-next-line no-console
      console.log('\n[LIVE kwanjula recommendation] %o', result);

      const extractionFailures = warnSpy.mock.calls
        .map((args) => String(args[0]))
        .filter((msg) => msg.includes('Knowledge extraction failed'));
      // eslint-disable-next-line no-console
      console.log('\n[LIVE extraction failures] %o', extractionFailures);
      expect(extractionFailures).toEqual([]);
      warnSpy.mockRestore();
    },
    120_000,
  );

  it(
    'admin document upload against the real Gemini API — the exact call shape ingestFromDocument sends, unmocked',
    async () => {
      const result = await service.ingestFromDocument({
        filename: 'live-test-budget.csv',
        mimeType: 'text/csv',
        data: Buffer.from('Item,Amount\nCatering,2500000\nVenue,4000000\n'),
        eventTypeHint: 'wedding',
        note: 'live e2e test fixture, not a real budget',
      });
      // eslint-disable-next-line no-console
      console.log('\n[LIVE admin upload] %o', result);
      // The real, meaningful assertion: Gemini actually accepted the tool
      // schema and returned something, not that the call merely didn't throw.
      expect(result.observationCount).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    'does not re-search the same topic within the cooldown window',
    async () => {
      await service.getRecommendation({ eventType: 'graduation party' });
      const afterFirst = await prisma.budgetKnowledgeSource.count({
        where: { name: { startsWith: 'live-search:graduation party' } },
      });
      expect(afterFirst).toBeGreaterThanOrEqual(1);

      await service.getRecommendation({ eventType: 'graduation party' });
      const afterSecond = await prisma.budgetKnowledgeSource.count({
        where: { name: { startsWith: 'live-search:graduation party' } },
      });
      // eslint-disable-next-line no-console
      console.log('\n[LIVE cooldown] afterFirst=%d afterSecond=%d', afterFirst, afterSecond);
      expect(afterSecond).toBe(afterFirst);
    },
    60_000,
  );
});
