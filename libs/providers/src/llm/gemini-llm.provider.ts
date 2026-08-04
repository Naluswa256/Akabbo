import {
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmMessage,
  LlmProvider,
  LlmToolCall,
} from './llm.provider';
import { LlmRateLimitedError } from '../provider.errors';

/**
 * Gemini adapter (primary LLM, blueprint §5) implementing our LlmProvider
 * interface via the REST generateContent API — vendor code stays isolated behind
 * the seam and never reaches domain code. Supports the multi-turn tool-use loop
 * the AI operating layer needs: function declarations, functionCall parsing, and
 * functionResponse replay.
 *
 * Gemini "thinking" models (e.g. gemini-flash-latest) require the functionCall's
 * `thoughtSignature` to be echoed back when the call is replayed — we carry it on
 * {@link LlmToolCall.signature} so the loop stays provider-agnostic.
 */
export class GeminiLlmProvider implements LlmProvider {
  readonly name = 'gemini';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');

    const contents = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => this.toContent(m));

    // Multimodal: attach documents/images to the LAST user turn as inline data
    // (blueprint §5 — replaces a dedicated OCR vendor). Attachments ride in the
    // user/content channel only, never the system instruction (§10).
    if (request.attachments?.length) {
      const lastUser = [...contents].reverse().find((c) => c.role === 'user');
      const target = lastUser ?? contents[contents.length - 1];
      if (target) {
        for (const a of request.attachments) {
          target.parts.push({
            inlineData: { mimeType: a.mimeType, data: a.data.toString('base64') },
          });
        }
      }
    }

    const generationConfig: Record<string, unknown> = { temperature: request.temperature ?? 0 };
    if (request.maxOutputTokens) generationConfig.maxOutputTokens = request.maxOutputTokens;
    // Minimizes the reasoning pass — see LlmCompletionRequest.disableThinking's
    // doc comment for why this matters. NOT a no-op if wrong: confirmed via a
    // real 400 INVALID_ARGUMENT that the older thinkingBudget:0 knob (valid on
    // pre-Gemini-3 models) is REJECTED outright by whatever GEMINI_MODEL='...
    // -latest' currently resolves to (gemini-3.6-flash at the time of writing)
    // — the model rejects the request rather than ignoring an unknown field.
    // thinkingLevel is Gemini 3's mechanism instead; verified directly against
    // the live API to actually drop thoughtsTokenCount to ~0. If a future
    // model rejects THIS shape too, prefer testing live over reusing whatever
    // the current model's docs say — this API has changed field shape once
    // already under this exact alias.
    if (request.disableThinking) generationConfig.thinkingConfig = { thinkingLevel: 'low' };

    const body: Record<string, unknown> = {
      contents,
      generationConfig,
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (request.tools?.length) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
      // 'required' forces a call (capture/extraction); default AUTO lets the
      // agent stop and answer in prose after tools run.
      const mode = request.toolChoice === 'required' ? 'ANY' : 'AUTO';
      body.toolConfig = { functionCallingConfig: { mode } };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const json = (await this.post(url, JSON.stringify(body))) as GeminiResponse;

    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const toolCalls: LlmToolCall[] = parts
      .filter((p): p is GeminiPart & { functionCall: GeminiFunctionCall } =>
        Boolean(p.functionCall),
      )
      .map((p) => ({
        id: p.functionCall.id,
        name: p.functionCall.name,
        arguments: p.functionCall.args ?? {},
        // Sibling of functionCall on the SAME part — must be echoed on replay.
        signature: p.thoughtSignature,
      }));
    const text = parts
      .filter((p): p is GeminiPart & { text: string } => typeof p.text === 'string')
      .map((p) => p.text)
      .join('');

    return {
      toolCalls,
      text: text || undefined,
      usage: {
        inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
        model: this.model,
      },
    };
  }

  /**
   * POST with retry + exponential backoff on TRANSIENT server errors. Gemini
   * returns 503 UNAVAILABLE ("the model is overloaded") under load — a temporary
   * Google-side condition, most common right after a model release and during
   * peak hours, that Google's own guidance says to retry. 429 (rate) and 500 are
   * likewise retried; 4xx (our bug) fail fast.
   *
   * Throws {@link LlmRateLimitedError} (not a generic Error) when 429/503
   * attempts are exhausted, so the assistant layer can surface a graceful
   * "assistant is busy" message rather than a hard failure.
   */
  private async post(url: string, body: string): Promise<unknown> {
    const RETRYABLE = new Set([429, 500, 503]);
    const RATE_LIMIT = new Set([429, 503]); // signals quota/overload, not our bug
    const maxAttempts = 4;
    let lastStatus = 0;
    let lastError = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body,
      });
      if (res.ok) return res.json();

      const text = await res.text();
      lastStatus = res.status;
      lastError = `Gemini request failed (${res.status}): ${text.slice(0, 300)}`;
      if (!RETRYABLE.has(res.status) || attempt === maxAttempts) break;
      // 0.5s, 1s, 2s + jitter — spread retries so we don't hammer a busy model.
      const backoffMs = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
    // Rate-limit / overload exhausted — throw a typed error so the caller
    // (AssistantService) can degrade gracefully rather than crashing the turn.
    if (RATE_LIMIT.has(lastStatus)) {
      throw new LlmRateLimitedError(lastStatus, lastError);
    }
    throw new Error(lastError);
  }

  /** Map one of our messages to a Gemini Content, preserving tool turns. */
  private toContent(m: LlmMessage): { role: string; parts: Array<Record<string, unknown>> } {
    // A tool turn: the results of previously-requested calls.
    if (m.role === 'tool' && m.toolResults?.length) {
      return {
        role: 'user',
        parts: m.toolResults.map((r) => ({
          functionResponse: { name: r.name, response: asStruct(r.content) },
        })),
      };
    }
    // An assistant turn that requested tool calls (replay them with signatures).
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const parts: Array<Record<string, unknown>> = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls) {
        const part: Record<string, unknown> = {
          functionCall: { name: tc.name, args: tc.arguments },
        };
        if (tc.signature) part.thoughtSignature = tc.signature;
        parts.push(part);
      }
      return { role: 'model', parts };
    }
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    };
  }
}

/** Gemini's functionResponse.response must be a JSON object; wrap non-objects. */
function asStruct(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { result: parsed };
  } catch {
    return { result: content };
  }
}

interface GeminiFunctionCall {
  name: string;
  args?: Record<string, unknown>;
  id?: string;
}
interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  thoughtSignature?: string;
}
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}
