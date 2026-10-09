/**
 * OpenAI-compatible Chat Completions provider.
 *
 * Works with OpenAI and with local servers that expose the same protocol
 * (Ollama `/v1`, LM Studio, llama.cpp server, vLLM). Images are sent as data
 * URLs; structured output uses `response_format: json_schema`.
 */
import { parseModelJson } from "../../shared/jsonSchema";
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

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(readonly config: ProviderConfig, private readonly getApiKey: () => string | undefined) {}

  isConfigured(): boolean {
    return Boolean(this.config.baseUrl) && (this.config.locality === "local" || Boolean(this.getApiKey()));
  }

  private headers(): Record<string, string> {
    const key = this.getApiKey();
    return { ...(this.config.headers || {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  }

  private base(model?: ModelDefinition): string {
    const url = model?.baseUrl || this.config.baseUrl;
    if (!url) throw new ModelError("NOT_CONFIGURED", `Provider ${this.config.id} has no base URL.`, { retryable: false });
    return url.replace(/\/+$/, "");
  }

  private body(model: ModelDefinition, request: GenerateRequest, stream: boolean) {
    const messages: Array<Record<string, unknown>> = [];
    if (request.system) messages.push({ role: "system", content: request.system });
    for (const message of request.messages) {
      messages.push({
        role: message.role === "model" ? "assistant" : "user",
        content: message.parts.map((part) => part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } }),
      });
    }
    const body: Record<string, unknown> = { model: model.modelName, messages, stream };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxOutputTokens) body.max_tokens = request.maxOutputTokens;
    if (request.responseSchema) {
      body.response_format = { type: "json_schema", json_schema: { name: "abxag_output", schema: request.responseSchema, strict: false } };
    }
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
      body.tool_choice = request.toolChoice === "required" ? "required" : request.toolChoice === "none" ? "none" : "auto";
    }
    if (stream) body.stream_options = { include_usage: true };
    return body;
  }

  async generate(model: ModelDefinition, request: GenerateRequest, context: ProviderContext): Promise<GenerateResponse> {
    const started = Date.now();
    const response = await postJson(`${this.base(model)}/chat/completions`, this.body(model, request, false), this.headers(), context, model.id);
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    const text = choice?.message?.content || "";
    const toolCalls = (choice?.message?.tool_calls || []).map((call) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        throw new ModelError("MALFORMED_TOOL_ARGS", `Tool ${call.function.name} returned invalid JSON arguments.`, { modelId: model.id, retryable: true });
      }
      return { id: call.id, name: call.function.name, args };
    });
    let json: unknown;
    if (request.responseSchema) {
      try {
        json = parseModelJson(text);
      } catch {
        throw new ModelError("INVALID_RESPONSE", "Model returned malformed JSON.", { modelId: model.id, retryable: true });
      }
    }
    if (choice?.finish_reason === "content_filter") throw new ModelError("SAFETY", "The model declined the request.", { modelId: model.id, retryable: false });
    return {
      text,
      toolCalls,
      json,
      usage: { inputTokens: data.usage?.prompt_tokens || 0, outputTokens: data.usage?.completion_tokens || 0, reasoningTokens: 0 },
      finishReason: choice?.finish_reason || "stop",
      modelId: model.id,
      latencyMs: Date.now() - started,
    };
  }

  async *stream(model: ModelDefinition, request: GenerateRequest, context: ProviderContext): AsyncIterable<StreamChunk> {
    const response = await postJson(`${this.base(model)}/chat/completions`, this.body(model, request, true), this.headers(), context, model.id);
    for await (const data of sseEvents(response)) {
      if (data === "[DONE]") break;
      try {
        const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield { textDelta: delta, done: false };
      } catch {
        /* ignore keep-alive noise */
      }
    }
    yield { textDelta: "", done: true };
  }

  async embed(model: ModelDefinition, texts: string[], context: ProviderContext): Promise<number[][]> {
    const response = await postJson(`${this.base(model)}/embeddings`, { model: model.modelName, input: texts }, this.headers(), context, model.id);
    const data = await response.json() as { data?: Array<{ embedding: number[] }> };
    return (data.data || []).map((item) => item.embedding);
  }

  async listModels(context: ProviderContext): Promise<string[]> {
    const data = await getJson<{ data?: Array<{ id: string }> }>(`${this.base()}/models`, this.headers(), context);
    return (data.data || []).map((item) => item.id);
  }
}

