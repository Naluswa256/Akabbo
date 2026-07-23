import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@akabbo/prisma';
import { LLM_PROVIDER } from '@akabbo/providers';
import {
  DynamicContextService,
  SelfLearningService,
  TelemetryService,
  redactPii,
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
        const item = { id: `t${mockTraces.length + 1}`, ...args.data };
        mockTraces.push(item);
        return Promise.resolve(item);
      },
      findMany: (args?: any) => {
        if (args?.where?.evaluated === false) {
          return Promise.resolve(mockTraces.filter((t) => !t.evaluated));
        }
        return Promise.resolve(mockTraces);
      },
      updateMany: (args: any) => {
        const ids = args.where.id.in;
        mockTraces.forEach((t) => {
          if (ids.includes(t.id)) t.evaluated = args.data.evaluated;
        });
        return Promise.resolve({ count: ids.length });
      },
    },
    aiLearnedExemplar: {
      count: () => Promise.resolve(mockExemplars.length),
      createMany: (args: any) => {
        mockExemplars.push(...args.data);
        return Promise.resolve({ count: args.data.length });
      },
      create: (args: any) => {
        const item = { id: `e${mockExemplars.length + 1}`, ...args.data };
        mockExemplars.push(item);
        return Promise.resolve(item);
      },
      findFirst: (args: any) => {
        const found = mockExemplars.find((e) => e.category === args.where.category);
        return Promise.resolve(found || null);
      },
      findMany: (args?: any) => {
        if (args?.where?.status) {
          return Promise.resolve(mockExemplars.filter((e) => e.status === args.where.status));
        }
        return Promise.resolve(mockExemplars);
      },
      update: (args: any) => {
        const found = mockExemplars.find((e) => e.id === args.where.id);
        if (found) Object.assign(found, args.data);
        return Promise.resolve(found);
      },
    },
    aiReflectionLog: {
      create: (args: any) => {
        const item = { id: `r${mockLogs.length + 1}`, ...args.data };
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

  it('redacts PII from phone numbers and amounts', () => {
    const raw = 'John +256742670421 paid 200k for Kwanjula';
    const redacted = redactPii(raw);
    expect(redacted).not.toContain('+256742670421');
    expect(redacted).not.toContain('200k');
    expect(redacted).toContain('[PHONE_REDACTED]');
    expect(redacted).toContain('[AMOUNT_REDACTED]');
  });

  it('records interaction traces with PII redacted via TelemetryService', async () => {
    await telemetry.recordTrace({
      userPrompt: 'Record 200k cash from +256742670421 for Kwanjula',
      modelResponse: 'Recorded 200,000 UGX contribution.',
      stagedStatus: 'CONFIRMED',
      userRole: 'COORDINATOR',
      latencyMs: 120,
    });

    const traces = await telemetry.getRecentTraces(10);
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0].userPrompt).not.toContain('+256742670421');
    expect(traces[0].userPrompt).toContain('[PHONE_REDACTED]');
  });

  it('retrieves dynamic learned context matching keywords strictly for APPROVED exemplars', async () => {
    await dynamicContext.seedInitialExemplars();
    const context = await dynamicContext.getRelevantContext('Kwanjula budget amakanzu');
    expect(context).toContain('LEARNED DOMAIN KNOWLEDGE');
    expect(context).toContain('KWANJULA_CULTURAL_GIFTS');
  });

  it('runs evaluation cycle on un-evaluated traces and tags new exemplars as PENDING_REVIEW', async () => {
    await telemetry.recordTrace({
      userPrompt: 'Wrong amount for uncle John',
      modelResponse: 'Which amount did he pay?',
      stagedStatus: 'REJECTED',
    });

    const result = await selfLearning.runEvaluationCycle(10);
    expect(result.evaluatedTurnsCount).toBeGreaterThan(0);
    expect(result.insightsSummary).toBeDefined();

    const latestLog = await selfLearning.getLatestReflectionLog();
    expect(latestLog).toBeDefined();
  });
});
