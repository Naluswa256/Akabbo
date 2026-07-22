/**
 * LLM provider interface (Phase 2).
 *
 * The AI is a replaceable interface, never the source of truth or authority
 * (CLAUDE.md §0, §4). Domain code depends on THIS interface; concrete adapters
 * (Gemini 2.5 Flash primary, Claude Haiku fallback) live behind it. Every
 * action-driving call returns a typed, schema-validated tool call — never free
 * prose we then parse.
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * On an `assistant` turn: the tool calls the model requested (so the next
   * request can echo them back before their results). On a `tool` turn: the
   * results of previously-requested calls. Both optional so single-shot capture
   * (Phase 2) is unaffected; the agentic read loop (the assistant) uses them.
   */
  toolCalls?: LlmToolCall[];
  toolResults?: LlmToolResult[];
}

/** The result of executing one tool call, fed back into the conversation. */
export interface LlmToolResult {
  /** Correlates to {@link LlmToolCall.id} when the provider supports ids. */
  id?: string;
  name: string;
  /** JSON string of the tool's structured output. */
  content: string;
}

/** A tool the model may call. Schema is a JSON Schema object. */
export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * A binary artifact passed to a MULTIMODAL model (blueprint §5): a photographed
 * budget, a scanned PDF, a handwritten contribution list. This is why Akabbo
 * needs no OCR vendor — a multimodal LLM reads messy documents directly.
 *
 * Attachments are DATA, never instructions (§10): adapters place them in the
 * user/content channel and never in the system instruction.
 */
export interface LlmAttachment {
  mimeType: string;
  data: Buffer;
  filename?: string;
}

export interface LlmCompletionRequest {
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  /** Documents/images for multimodal extraction (Phase 4). */
  attachments?: LlmAttachment[];
  /** Deterministic bias; capture wants low temperature. */
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * 'required' forces the model to emit a tool call (single-shot capture /
   * extraction); 'auto' (default) lets it call tools OR answer in prose, which
   * the agentic read loop needs so it can stop and reply.
   */
  toolChoice?: 'auto' | 'required';
}

/** A structured tool call the model requested. Validated by the caller. */
export interface LlmToolCall {
  /** Provider-assigned call id, echoed on the matching {@link LlmToolResult}. */
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Opaque provider signature that MUST be echoed back when this tool call is
   * replayed in a later turn. Gemini "thinking" models require the functionCall's
   * `thoughtSignature`; carrying it here keeps the loop provider-agnostic.
   */
  signature?: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface LlmCompletionResult {
  /** Present when the model chose to call a tool. */
  toolCalls: LlmToolCall[];
  /** Present when the model returned prose (e.g. phrasing a SQL answer). */
  text?: string;
  usage: LlmUsage;
}

export interface LlmProvider {
  /**
   * Run a completion. Implementations must record a `usage_event` for cost
   * attribution (metering-for-observability, never billing — metering doc §1).
   */
  complete(request: LlmCompletionRequest): Promise<LlmCompletionResult>;
}
