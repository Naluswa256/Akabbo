import {
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmProvider,
  LlmToolCall,
} from './llm.provider';

/**
 * Claude adapter (fallback LLM, blueprint §5) implementing our LlmProvider
 * interface via the Anthropic Messages REST API. Model id `claude-haiku-4-5`
 * per the claude-api reference. Vendor code isolated behind the seam.
 *
 * Not exercised until ANTHROPIC_API_KEY is set (used as fallback when the
 * primary errors). Structured output via tool_use with tool_choice=any.
 */
export class AnthropicLlmProvider implements LlmProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const messages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxOutputTokens ?? 1024,
      system,
      messages,
    };
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
      body.tool_choice = { type: 'any' };
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic request failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as AnthropicResponse;

    const blocks = json.content ?? [];
    const toolCalls: LlmToolCall[] = blocks
      .filter(
        (b): b is { type: 'tool_use'; name: string; input: Record<string, unknown> } =>
          b.type === 'tool_use',
      )
      .map((b) => ({ name: b.name, arguments: b.input ?? {} }));
    const text = blocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return {
      toolCalls,
      text: text || undefined,
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
        model: this.model,
      },
    };
  }
}

interface AnthropicResponse {
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; name: string; input: Record<string, unknown> }
    | { type: string; [k: string]: unknown }
  >;
  usage?: { input_tokens?: number; output_tokens?: number };
}
