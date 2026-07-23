import { Module } from '@nestjs/common';
import { LedgerModule } from '@akabbo/ledger';
import { TransparencyModule } from '@akabbo/transparency';
import { CommsModule } from '@akabbo/comms';
import { BillingModule } from '@akabbo/billing';
import { EntityResolver } from './entity-resolver.service';
import { ToolExecutor } from './tool-executor.service';
import { ConfirmationService } from './confirmation.service';
import { UsageMeter } from './usage-meter.service';
import { CaptureService } from './capture.service';
import { AiQueryService } from './agent/ai-query.service';
import { AiMutationService } from './agent/ai-mutation.service';
import { AssistantService } from './agent/assistant.service';
import { ConversationService } from './agent/conversation.service';
import { ConversationOrchestrator } from './agent/conversation-orchestrator.service';
import { TelemetryService } from './telemetry.service';
import { DynamicContextService } from './dynamic-context.service';
import { SelfLearningService } from './self-learning.service';

/**
 * The AI capture context (Phase 2). NOT a bounded context — an application-layer
 * adapter that calls the Ledger services as tools (blueprint §2.4). It depends
 * on LedgerModule (the domain), AccessModule (permission gate, global), and the
 * LLM_PROVIDER (global, from ProvidersModule).
 */
@Module({
  imports: [LedgerModule, TransparencyModule, CommsModule, BillingModule],
  providers: [
    EntityResolver,
    ToolExecutor,
    ConfirmationService,
    UsageMeter,
    CaptureService,
    AiQueryService,
    AiMutationService,
    AssistantService,
    ConversationService,
    ConversationOrchestrator,
    TelemetryService,
    DynamicContextService,
    SelfLearningService,
  ],
  // UsageMeter is exported so the Documents context meters multimodal
  // extraction through the one meter (blueprint §5 usage accounting).
  exports: [
    CaptureService,
    ConfirmationService,
    UsageMeter,
    AiQueryService,
    AssistantService,
    ConversationService,
    ConversationOrchestrator,
    TelemetryService,
    DynamicContextService,
    SelfLearningService,
  ],
})
export class AiModule {}
