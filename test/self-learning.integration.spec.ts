import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@akabbo/prisma';
import { LLM_PROVIDER } from '@akabbo/providers';
import {
  DynamicContextService,
  SelfLearningService,
  TelemetryService,
} from '@akabbo/ai';

class ScriptedLlm {
  readonly name = 'scripted';
  complete() {
    return Promise.resolve({
      toolCalls: [],
      text: 'Suggested rule: Ensure Kwanjula gift pledges map to items.',
      usage: { inputTokens: 50, outputTokens: 20, model: 'scripted' },
    });
  }
}

describe('AI Self-Learning & Improving Layer (Integration)', () => {
  let moduleRef: TestingModule;
  let telemetry: TelemetryService;
  let dynamicContext: DynamicContextService;
  let selfLearning: SelfLearningService;

  const mockTraces: any[] = [];
  const mockExemplars: any[] = [];
  const mockLogs: any[] = [];

  const mockPrisma = {
    aiInteractionTrace: {
      create: (args: any) => {
        const item = { id: 't1', ...args.data };
        mockTraces.push(item);
        return Promise.resolve(item);
      },
      findMany: () => Promise.resolve(mockTraces),
    },
    aiLearnedExemplar: {
      count: () => Promise.resolve(mockExemplars.length),
      createMany: (args: any) => {
        mockExemplars.push(...args.data);
        return Promise.resolve({ count: args.data.length });
      },
      create: (args: any) => {
        const item = { id: 'e1', ...args.data };
        mockExemplars.push(item);
        return Promise.resolve(item);
      },
      findMany: () => Promise.resolve(mockExemplars),
    },
    aiReflectionLog: {
      create: (args: any) => {
        const item = { id: 'r1', ...args.data };
        mockLogs.push(item);
        return Promise.resolve(item);
      },
      findFirst: () => Promise.resolve(mockLogs[mockLogs.length - 1] || null),
    },
  };

  beforeAll(async () => {
    const llm = new ScriptedLlm();
    moduleRef = await Test.createTestingModule({
      providers: [
        TelemetryService,
        DynamicContextService,
        SelfLearningService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LLM_PROVIDER, useValue: llm },
      ],
    }).compile();

    telemetry = moduleRef.get(TelemetryService);
    dynamicContext = moduleRef.get(DynamicContextService);
    selfLearning = moduleRef.get(SelfLearningService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('records interaction traces via TelemetryService', async () => {
    await telemetry.recordTrace({
      userPrompt: 'Record 200k cash from Sarah for Kwanjula',
      modelResponse: 'Recorded 200,000 UGX contribution.',
      stagedStatus: 'CONFIRMED',
      userRole: 'COORDINATOR',
      latencyMs: 120,
    });

    const traces = await telemetry.getRecentTraces(10);
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0].userPrompt).toContain('Kwanjula');
  });

  it('retrieves dynamic learned context matching keywords', async () => {
    await dynamicContext.seedInitialExemplars();
    const context = await dynamicContext.getRelevantContext('Kwanjula budget amakanzu');
    expect(context).toContain('LEARNED DOMAIN KNOWLEDGE');
    expect(context).toContain('KWANJULA_BUDGET');
  });

  it('runs evaluation cycle and logs reflection insights', async () => {
    const result = await selfLearning.runEvaluationCycle(10);
    expect(result.evaluatedTurnsCount).toBeGreaterThanOrEqual(0);
    expect(result.insightsSummary).toBeDefined();

    const latestLog = await selfLearning.getLatestReflectionLog();
    expect(latestLog).toBeDefined();
  });
});
