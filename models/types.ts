/**
 * Provider-independent model contracts.
 *
 * ABxAG's brain talks only in these types. A provider adapter (Gemini,
 * OpenAI-compatible, Anthropic-compatible, …) translates them to its wire
 * format, and the registry describes models purely through configuration.
 */

export type ApiType = "gemini" | "openai-compatible" | "anthropic-compatible";

export type ModelTask =
  | "conversation"
  | "planning"
  | "vision"
  | "grounding"
  | "coding"
  | "classification"
  | "summarization"
  | "embedding"
  | "live_voice";

export interface ModelCapabilities {
  vision: boolean;
  tools: boolean;
  /** Native JSON-schema constrained output. */
  structuredOutput: boolean;
  reasoning: boolean;
  streaming: boolean;
  /** Bidirectional realtime audio (Gemini Live). */
  liveAudio: boolean;
  embedding: boolean;
}

export interface ModelDefinition {
  id: string;
  displayName: string;
  /** Provider instance ID from the provider config (not the API type). */
  provider: string;
  /** Model name sent on the wire. */
  modelName: string;
  apiType: ApiType;
  baseUrl?: string;
  capabilities: ModelCapabilities;
  contextLength: number;
  maxOutputTokens?: number;
  /** Relative speed/quality tier used by AUTO routing. */
  tier: "fast" | "balanced" | "deep";
  locality: "local" | "cloud";
  cost: { inputPerMTok?: number; outputPerMTok?: number; note?: string };
  icon?: string;
  accent?: string;
  recommendedTasks: ModelTask[];
  description?: string;
  enabled: boolean;
  /** Provider-specific knobs (e.g. Gemini thinking level). */
  options?: Record<string, unknown>;
}

export interface ProviderConfig {
  id: string;
  apiType: ApiType;
  displayName: string;
  baseUrl?: string;
  /** Name of the entry in the protected secret store. */
  secretName?: string;
  enabled: boolean;
  locality: "local" | "cloud";
  /** Extra HTTP headers (never secrets). */
  headers?: Record<string, string>;
}

export type Part =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export interface ChatMessage {
  role: "user" | "model";
  parts: Part[];
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON schema (object) for the arguments. */
  parameters: Record<string, unknown>;
}

export interface GenerateRequest {
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  toolChoice?: "auto" | "required" | "none";
  /** JSON schema for structured output. */
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  reasoning?: "off" | "low" | "medium" | "high";
  /** Short label for logging/usage (e.g. "planner.step"). */
  purpose: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface GenerateResponse {
  text: string;
  toolCalls: ToolCall[];
  /** Parsed structured output when a responseSchema was supplied. */
  json?: unknown;
  usage: Usage;
  finishReason: string;
  modelId: string;
  latencyMs: number;
}

export interface StreamChunk {
  textDelta: string;
  done: boolean;
  usage?: Usage;
}

export type ModelErrorCode =
  | "AUTH"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "SERVER"
  | "NETWORK"
  | "INVALID_RESPONSE"
  | "MALFORMED_TOOL_ARGS"
  | "CONTEXT_LIMIT"
  | "SAFETY"
  | "CANCELLED"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "UNAVAILABLE"
  | "NOT_CONFIGURED";

export class ModelError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
    readonly options: { retryable?: boolean; retryAfterMs?: number; status?: number; modelId?: string; quotaPerMinute?: number } = {},
  ) {
    super(message);
    this.name = "ModelError";
  }

  get retryable(): boolean {
    return this.options.retryable ?? ["RATE_LIMIT", "TIMEOUT", "SERVER", "NETWORK", "UNAVAILABLE"].includes(this.code);
  }

  /** Errors after which a different model could reasonably succeed. */
  get fallbackEligible(): boolean {
    return ["RATE_LIMIT", "TIMEOUT", "SERVER", "NETWORK", "UNAVAILABLE", "NOT_FOUND", "CONTEXT_LIMIT", "INVALID_RESPONSE"].includes(this.code);
  }

  /** Short, user-facing explanation. */
  get userMessage(): string {
    switch (this.code) {
      case "AUTH": return "The API key was rejected. Check it in Settings → AI / Models.";
      case "RATE_LIMIT": return "The model is rate-limited right now.";
      case "TIMEOUT": return "The model took too long to answer.";
      case "SERVER": return "The model service had a temporary error.";
      case "NETWORK": return "I can't reach the model service — the internet may be down.";
      case "CONTEXT_LIMIT": return "That request was too large for the model.";
      case "SAFETY": return "The model declined that request.";
      case "CANCELLED": return "Cancelled.";
      case "NOT_FOUND": return "That model isn't available for this API key.";
      case "NOT_CONFIGURED": return "This model's provider isn't configured yet.";
      default: return this.message;
    }
  }
}

export interface ProviderContext {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ModelProvider {
  readonly config: ProviderConfig;
  generate(model: ModelDefinition, request: GenerateRequest, context: ProviderContext): Promise<GenerateResponse>;
  stream?(model: ModelDefinition, request: GenerateRequest, context: ProviderContext): AsyncIterable<StreamChunk>;
  embed?(model: ModelDefinition, texts: string[], context: ProviderContext): Promise<number[][]>;
  listModels?(context: ProviderContext): Promise<string[]>;
  isConfigured(): boolean;
}

