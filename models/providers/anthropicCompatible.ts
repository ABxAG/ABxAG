/**
 * Anthropic Messages-API compatible provider.
 *
 * Structured output is obtained by forcing a single tool whose input schema is
 * the requested response schema, which every Messages-compatible server
 * supports. Streaming uses `content_block_delta` events.
 */
import {
  ModelError,
  type GenerateRequest,
  type GenerateResponse,
  type ModelDefinition,
  type ModelProvider,
  type ProviderConfig,
  type ProviderContext,
  type StreamChunk,
} from "../types";
import { getJson, postJson, sseEvents } from "./http";

const STRUCTURED_TOOL = "abxag_structured_output";

export class AnthropicCompatibleProvider implements ModelProvider {
  constructor(readonly config: ProviderConfig, private readonly getApiKey: () => string | undefined) {}

  isConfigured(): boolean {
    return Boolean(this.config.baseUrl && this.getApiKey());
  }

  private headers(): Record<string, string> {
    const key = this.getApiKey();
    if (!key) throw new ModelError("NOT_CONFIGURED", `Provider ${this.config.id} has no API key.`, { retryable: false });
    return { ...(this.config.headers || {}), "x-api-key": key, "anthropic-version": "2023-06-01" };
  }

  private base(model?: ModelDefinition): string {
    return (model?.baseUrl || this.config.baseUrl || "").replace(/\/+$/, "");
  }

  private body(model: ModelDefinition, request: GenerateRequest, stream: boolean) {
    const body: Record<string, unknown> = {
      model: model.modelName,
      max_tokens: request.maxOutputTokens || model.maxOutputTokens || 4096,
      messages: request.messages.map((message) => ({
        role: message.role === "model" ? "assistant" : "user",
        content: message.parts.map((part) => part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } }),
      })),
      stream,
    };
    if (request.system) body.system = request.system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    const tools = (request.tools || []).map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
    if (request.responseSchema) {
      tools.push({ name: STRUCTURED_TOOL, description: "Return the response in this exact structure.", input_schema: request.responseSchema });
      body.tool_choice = { type: "tool", name: STRUCTURED_TOOL };
    } else if (tools.length) {
      body.tool_choice = request.toolChoice === "required" ? { type: "any" } : request.toolChoice === "none" ? { type: "none" } : { type: "auto" };
    }
    if (tools.length) body.tools = tools;
    return body;
  }

  async generate(model: ModelDefinition, request: GenerateRequest, context: ProviderContext): Promise<GenerateResponse> {
    const started = Date.now();
    const response = await postJson(`${this.base(model)}/v1/messages`, this.body(model, request, false), this.headers(), context, model.id);
    const data = await response.json() as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const blocks = data.content || [];
    const text = blocks.filter((block) => block.type === "text").map((block) => block.text || "").join("");
    const toolUses = blocks.filter((block) => block.type === "tool_use");
    const structured = toolUses.find((block) => block.name === STRUCTURED_TOOL);
    if (request.responseSchema && !structured) {
      throw new ModelError("INVALID_RESPONSE", "Model did not return the structured output.", { modelId: model.id, retryable: true });
    }
    if (data.stop_reason === "refusal") throw new ModelError("SAFETY", "The model declined the request.", { modelId: model.id, retryable: false });
    return {
      text,
      toolCalls: toolUses.filter((block) => block.name !== STRUCTURED_TOOL).map((block, index) => ({
        id: block.id || `tool_${index}`,
        name: block.name || "",
        args: block.input || {},
      })),
      json: structured?.input,
      usage: { inputTokens: data.usage?.input_tokens || 0, outputTokens: data.usage?.output_tokens || 0, reasoningTokens: 0 },
      finishReason: data.stop_reason || "end_turn",
      modelId: model.id,
      latencyMs: Date.now() - started,
    };
  }

  async *stream(model: ModelDefinition, request: GenerateRequest, context: ProviderContext): AsyncIterable<StreamChunk> {
    const response = await postJson(`${this.base(model)}/v1/messages`, this.body(model, { ...request, responseSchema: undefined }, true), this.headers(), context, model.id);
    for await (const data of sseEvents(response)) {
      try {
        const event = JSON.parse(data) as { type?: string; delta?: { type?: string; text?: string } };
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          yield { textDelta: event.delta.text, done: false };
        }
      } catch {
        /* ignore */
      }
    }
    yield { textDelta: "", done: true };
  }

  async listModels(context: ProviderContext): Promise<string[]> {
    const data = await getJson<{ data?: Array<{ id: string }> }>(`${this.base()}/v1/models`, this.headers(), context);
    return (data.data || []).map((item) => item.id);
  }
}

