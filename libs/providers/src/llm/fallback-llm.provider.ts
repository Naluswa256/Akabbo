import { Logger } from '@nestjs/common';
import { LlmCompletionRequest, LlmCompletionResult, LlmProvider } from './llm.provider';

/**
 * Tries an ordered list of providers, falling through to the next on error
 * (blueprint §5: Gemini primary, Claude fallback). The tiered-routing cost win
 * is upstream (deterministic tier-1); this only guards against a primary
 * outage. Throws the last error if every provider fails.
 */
export class FallbackLlmProvider implements LlmProvider {
  private readonly logger = new Logger(FallbackLlmProvider.name);
  readonly name = 'fallback';

  constructor(private readonly providers: LlmProvider[]) {
    if (providers.length === 0) throw new Error('FallbackLlmProvider needs at least one provider');
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    let lastErr: unknown;
    for (const provider of this.providers) {
      try {
        return await provider.complete(request);
      } catch (err) {
        lastErr = err;
        this.logger.warn(
          `LLM provider '${(provider as { name?: string }).name ?? 'unknown'}' failed; trying next`,
        );
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('All LLM providers failed');
  }
}
