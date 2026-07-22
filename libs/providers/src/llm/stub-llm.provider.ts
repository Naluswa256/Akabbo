import { Injectable } from '@nestjs/common';
import { ProviderNotImplementedError } from '../provider.errors';
import { LlmCompletionRequest, LlmCompletionResult, LlmProvider } from './llm.provider';

/** Phase 0 stub — fails loud if invoked. Real adapter: Phase 2. */
@Injectable()
export class StubLlmProvider implements LlmProvider {
  readonly name = 'stub';

  complete(_request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    throw new ProviderNotImplementedError('LlmProvider', 'complete', 'Phase 2');
  }
}
