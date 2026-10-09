/**
 * Gemini provider: the only module that speaks the Gemini REST protocol.
 *
 * Supports text + image input, JSON-schema structured output, function
 * calling, streaming, embeddings, thinking levels, per-request timeouts and
 * cancellation. Everything above this file is provider-neutral.
 */
import { FunctionCallingConfigMode, GoogleGenAI, ThinkingLevel, type Content, type GenerateContentConfig, type GenerateContentResponse } from "@google/genai";
import { parseModelJson } from "../../../shared/jsonSchema";
import {
  ModelError,
  type ChatMessage,
  type GenerateRequest,
  type GenerateResponse,
  type ModelDefinition,
  type ModelProvider,
  type ProviderConfig,
  type ProviderContext,
  type StreamChunk,
  type ToolCall,
} from "../../types";
import { classifyGeminiError } from "./errors";

const THINKING: Record<string, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export class GeminiProvider implements ModelProvider {
  private client: GoogleGenAI | null = null;
  private clientKey: string | null = null;
  /** Models that rejected a thinking configuration; it is omitted for them afterwards. */
  private readonly noThinking = new Set<string>();

  constructor(readonly config: ProviderConfig, private readonly getApiKey: () => string | undefined) {}

  isConfigured(): boolean {
    return Boolean(this.getApiKey());
  }

  private ai(): GoogleGenAI {
    const key = this.getApiKey();
    if (!key) throw new ModelError("NOT_CONFIGURED", "No Gemini API key is configured.", { retryable: false });
    if (!this.client || this.clientKey !== key) {
      // The key is always passed explicitly so a stray GOOGLE_API_KEY in the
      // environment can never silently take precedence.
      this.client = new GoogleGenAI({ apiKey: key });
      this.clientKey = key;
    }
    return this.client;
  }

  async generate(model: ModelDefinition, request: GenerateRequest, context: ProviderContext): Promise<GenerateResponse> {
    const started = Date.now();
    const { signal, timedOut, cleanup, cancelledByCaller } = composeSignal(context);
    try {
      const response = await this.callWithThinkingFallback(model, request, signal);
      const parsed = this.toResponse(model, request, response, Date.now() - started);
      return parsed;
    } catch (error) {
      throw classifyGeminiError(error, model.id, cancelledByCaller(), timedOut());
    } finally {
      cleanup();
    }
  }

  private async callWithThinkingFallback(model: ModelDefinition, request: GenerateRequest, signal: AbortSignal): Promise<GenerateContentResponse> {
    const config = this.buildConfig(model, request, signal);
    try {
      return await this.ai().models.generateContent({ model: model.modelName, contents: toContents(request.messages), config });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (config.thinkingConfig && /thinking/i.test(message) && Number((error as { status?: number }).status) === 400) {
        this.noThinking.add(model.id);
        const retryConfig = { ...config };
        delete retryConfig.thinkingConfig;
        return await this.ai().models.generateContent({ model: model.modelName, contents: toContents(request.messages), config: retryConfig });
      }
      throw error;
    }
  }

  async *stream(model: ModelDefinition, request: GenerateRequest, context: ProviderContext): AsyncIterable<StreamChunk> {
    const { signal, timedOut, cleanup, cancelledByCaller } = composeSignal(context);
    try {
      const config = this.buildConfig(model, request, signal);
      const stream = await this.ai().models.generateContentStream({
        model: model.modelName,
        contents: toContents(request.messages),
        config,
      });
      let usage: GenerateResponse["usage"] | undefined;
      for await (const chunk of stream) {
        if (signal.aborted) throw new ModelError("CANCELLED", "Cancelled.", { retryable: false });
        usage = usageOf(chunk) || usage;
        const text = visibleText(chunk);
        if (text) yield { textDelta: text, done: false };
      }
      yield { textDelta: "", done: true, usage };
    } catch (error) {
      throw classifyGeminiError(error, model.id, cancelledByCaller(), timedOut());
    } finally {
      cleanup();
    }
  }

  async embed(model: ModelDefinition, texts: string[], context: ProviderContext): Promise<number[][]> {
    const { signal, timedOut, cleanup, cancelledByCaller } = composeSignal(context);
    try {
      const response = await this.ai().models.embedContent({
        model: model.modelName,
        contents: texts,
        config: { abortSignal: signal },
      });
      return (response.embeddings || []).map((embedding) => embedding.values || []);
    } catch (error) {
      throw classifyGeminiError(error, model.id, cancelledByCaller(), timedOut());
    } finally {
      cleanup();
    }
  }

  async listModels(context: ProviderContext): Promise<string[]> {
    const { signal, timedOut, cleanup, cancelledByCaller } = composeSignal({ timeoutMs: 15_000, ...context });
    try {
      const pager = await this.ai().models.list({ config: { pageSize: 200, abortSignal: signal } });
      const names: string[] = [];
      for await (const entry of pager) {
        if (entry.name) names.push(entry.name.replace(/^models\//, ""));
        if (names.length > 400) break;
      }
      return names;
    } catch (error) {
      throw classifyGeminiError(error, "models.list", cancelledByCaller(), timedOut());
    } finally {
      cleanup();
    }
  }

  private buildConfig(model: ModelDefinition, request: GenerateRequest, signal: AbortSignal): GenerateContentConfig {
    const config: GenerateContentConfig = { abortSignal: signal };
    if (request.system) config.systemInstruction = request.system;
    if (request.temperature !== undefined) config.temperature = request.temperature;
    const maxOutput = request.maxOutputTokens ?? model.maxOutputTokens;
    if (maxOutput) config.maxOutputTokens = maxOutput;
    if (request.responseSchema) {
      config.responseMimeType = "application/json";
      config.responseJsonSchema = request.responseSchema;
    }
    if (request.tools?.length) {
      config.tools = [{
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: tool.parameters,
        })),
      }];
      config.toolConfig = {
        functionCallingConfig: {
          mode: request.toolChoice === "required"
            ? FunctionCallingConfigMode.ANY
            : request.toolChoice === "none" ? FunctionCallingConfigMode.NONE : FunctionCallingConfigMode.AUTO,
        },
      };
    }
    const level = request.reasoning && request.reasoning !== "off"
      ? request.reasoning
      : request.reasoning === "off" ? "minimal" : String(model.options?.thinkingLevel || "");
    if (model.capabilities.reasoning && level && THINKING[level] && !this.noThinking.has(model.id)) {
      config.thinkingConfig = { thinkingLevel: THINKING[level] };
    }
    return config;
  }

  private toResponse(model: ModelDefinition, request: GenerateRequest, response: GenerateContentResponse, latencyMs: number): GenerateResponse {
    const blocked = response.promptFeedback?.blockReason;
    const candidate = response.candidates?.[0];
    const finishReason = String(candidate?.finishReason || (blocked ? "BLOCKED" : "STOP"));
    if (blocked || /SAFETY|PROHIBITED|BLOCKLIST|SPII/.test(finishReason)) {
      throw new ModelError("SAFETY", `Gemini declined the request (${blocked || finishReason}).`, { modelId: model.id, retryable: false });
    }
    const text = visibleText(response);
    const toolCalls: ToolCall[] = (response.functionCalls || []).map((call, index) => ({
      id: call.id || `call_${index}`,
      name: String(call.name || ""),
      args: (call.args && typeof call.args === "object" ? call.args : {}) as Record<string, unknown>,
    }));
    let json: unknown;
    if (request.responseSchema) {
      if (!text.trim()) {
        throw new ModelError("INVALID_RESPONSE", `Empty structured response (finish: ${finishReason}).`, { modelId: model.id, retryable: true });
      }
      try {
        json = parseModelJson(text);
      } catch {
        throw new ModelError("INVALID_RESPONSE", `Model returned malformed JSON (finish: ${finishReason}).`, { modelId: model.id, retryable: true });
      }
    } else if (!text.trim() && toolCalls.length === 0) {
      throw new ModelError("INVALID_RESPONSE", `Empty model response (finish: ${finishReason}).`, { modelId: model.id, retryable: true });
    }
    return {
      text,
      toolCalls,
      json,
      usage: usageOf(response) || { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      finishReason,
      modelId: model.id,
      latencyMs,
    };
  }
}

function toContents(messages: ChatMessage[]): Content[] {
  return messages.map((message) => ({
    role: message.role,
    parts: message.parts.map((part) => part.type === "text"
      ? { text: part.text }
      : { inlineData: { mimeType: part.mimeType, data: part.data } }),
  }));
}

/** Text parts excluding thought summaries. */
function visibleText(response: GenerateContentResponse): string {
  const parts = response.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((part) => part.thought !== true && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function usageOf(response: GenerateContentResponse): GenerateResponse["usage"] | undefined {
  const meta = response.usageMetadata;
  if (!meta) return undefined;
  return {
    inputTokens: meta.promptTokenCount || 0,
    outputTokens: meta.candidatesTokenCount || 0,
    reasoningTokens: meta.thoughtsTokenCount || 0,
  };
}

/** Merge caller cancellation with a timeout while remembering which fired. */
export function composeSignal(context: ProviderContext) {
  const controller = new AbortController();
  let timedOutFlag = false;
  let callerCancelled = false;
  const onAbort = () => {
    callerCancelled = true;
    controller.abort();
  };
  if (context.signal?.aborted) onAbort();
  context.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = context.timeoutMs
    ? setTimeout(() => {
        timedOutFlag = true;
        controller.abort();
      }, context.timeoutMs)
    : null;
  timer?.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timedOutFlag,
    cancelledByCaller: () => callerCancelled,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      context.signal?.removeEventListener("abort", onAbort);
    },
  };
}
