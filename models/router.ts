/**
 * ModelRouter: chooses which configured model serves a request.
 *
 * - An explicitly selected model is used as-is. Another model is used only
 *   when (a) the user allowed fallback and the selected model failed, or
 *   (b) the request needs a capability the selected model lacks (e.g. an
 *   image) — that substitution is announced, never silent.
 * - AUTO ranks models by capability fit, tier for the task, recommendation,
 *   recent health and connectivity — never by model-name assumptions.
 * - Offline, cloud models are skipped; local ones are used if permitted.
 */
import { appEvents } from "../shared/appEvents";
import { createLogger } from "../shared/logger";
import { NetworkMonitor } from "./network";
import { ModelRateLimiter } from "./rateLimit";
import type { ModelRegistry } from "./registry";
import { withRetry } from "./retry";
import { UsageTracker } from "./usage";
import {
  ModelError,
  type GenerateRequest,
  type GenerateResponse,
  type ModelDefinition,
  type ModelTask,
  type StreamChunk,
} from "./types";

const log = createLogger("models.router");

export interface RouteRequirements {
  vision?: boolean;
  tools?: boolean;
  structuredOutput?: boolean;
  /** 0..1 estimate of task difficulty; high values prefer deep models in AUTO. */
  complexity?: number;
  /** Force a specific model for this call (e.g. the UI's "test model" button). */
  modelId?: string;
  /** "background" work follows the background selection instead of the brain selection. */
  role?: "brain" | "background";
}

interface Health {
  failures: number[];
  coolDownUntil: number;
  /** Consecutive overload failures, for the escalating cool-down. */
  overloads?: number;
}

const TASK_TIER: Record<ModelTask, Array<ModelDefinition["tier"]>> = {
  conversation: ["fast", "balanced", "deep"],
  classification: ["fast", "balanced", "deep"],
  summarization: ["fast", "balanced", "deep"],
  planning: ["balanced", "deep", "fast"],
  vision: ["balanced", "fast", "deep"],
  grounding: ["balanced", "deep", "fast"],
  coding: ["deep", "balanced", "fast"],
  embedding: ["fast", "balanced", "deep"],
  live_voice: ["fast", "balanced", "deep"],
};

export class ModelRouter {
  readonly usage = new UsageTracker();
  readonly limiter = new ModelRateLimiter();
  private readonly health = new Map<string, Health>();

  constructor(readonly registry: ModelRegistry, readonly network: NetworkMonitor = new NetworkMonitor()) {}

  /** Ordered candidate list for a task. Throws when nothing can serve it. */
  candidates(task: ModelTask, requirements: RouteRequirements = {}): ModelDefinition[] {
    const selection = this.registry.getSelection();
    const offline = this.network.current === "offline";
    const usable = (model: ModelDefinition) => {
      const availability = this.registry.availability(model);
      if (availability === "disabled" || availability === "not_configured" || availability === "unavailable") return false;
      if (offline && model.locality === "cloud") return false;
      return this.satisfies(model, task, requirements);
    };

    const forcedId = requirements.modelId || (requirements.role === "background" && selection.background !== "auto" ? selection.background : undefined);
    if (forcedId) {
      const forced = this.registry.getModel(forcedId);
      if (!forced) throw new ModelError("NOT_FOUND", `Unknown model ${forcedId}.`, { retryable: false });
      return [forced];
    }

    const ranked = this.registry.allModels().filter(usable).sort((a, b) => this.score(b, task, requirements) - this.score(a, task, requirements));

    if (selection.brain === "auto" || task === "embedding" || requirements.role === "background") {
      if (!ranked.length) throw this.noModelError(task, offline);
      return ranked;
    }

    const selected = this.registry.getModel(selection.brain);
    const selectedUsable = selected ? usable(selected) : false;
    if (selected && selectedUsable) {
      const fallbacks = selection.fallbackAllowed ? ranked.filter((model) => model.id !== selected.id) : [];
      return [selected, ...fallbacks];
    }
    if (selected && !this.satisfies(selected, task, requirements) && ranked.length) {
      // Capability gap (e.g. a text-only model asked to look at the screen).
      appEvents.publish("model.status", {
        kind: "capability_substitution",
        selected: selected.displayName,
        using: ranked[0].displayName,
        reason: requirements.vision ? "needs vision" : `needs ${task}`,
      });
      return [ranked[0]];
    }
    if (offline && selection.offlineLocalFallback) {
      const local = ranked.filter((model) => model.locality === "local");
      if (local.length) {
        appEvents.publish("model.status", { kind: "offline_local", using: local[0].displayName });
        return local;
      }
    }
    if (selection.fallbackAllowed && ranked.length) return ranked;
    throw selected
      ? new ModelError(offline ? "NETWORK" : "UNAVAILABLE", offline
          ? `${selected.displayName} needs the internet and you're offline.`
          : `${selected.displayName} is not available (${this.registry.availability(selected)}).`, { retryable: false, modelId: selected.id })
      : this.noModelError(task, offline);
  }

  private noModelError(task: ModelTask, offline: boolean): ModelError {
    return new ModelError(offline ? "NETWORK" : "NOT_CONFIGURED", offline
      ? "You're offline and no local model is configured."
      : `No configured model can handle ${task}.`, { retryable: false });
  }

  private satisfies(model: ModelDefinition, task: ModelTask, requirements: RouteRequirements): boolean {
    const caps = model.capabilities;
    if (task === "embedding") return caps.embedding;
    if (task === "live_voice") return caps.liveAudio;
    if (caps.embedding || caps.liveAudio) return false;
    if ((requirements.vision || task === "vision" || task === "grounding") && !caps.vision) return false;
    if (requirements.tools && !caps.tools) return false;
    if (requirements.structuredOutput && !caps.structuredOutput) return false;
    return true;
  }

  private score(model: ModelDefinition, task: ModelTask, requirements: RouteRequirements): number {
    const tiers = [...TASK_TIER[task]];
    if ((requirements.complexity ?? 0) >= 0.75 && task !== "conversation") tiers.unshift("deep");
    let score = 100 - tiers.indexOf(model.tier) * 25;
    if (model.recommendedTasks.includes(task)) score += 20;
    if (this.registry.availability(model) === "available") score += 10;
    if (model.locality === "local" && this.network.current === "offline") score += 50;
    const health = this.health.get(model.id);
    if (health) {
      if (health.coolDownUntil > Date.now()) score -= 200;
      score -= health.failures.filter((at) => Date.now() - at < 120_000).length * 15;
    }
    if (requirements.role !== "background" && this.registry.getSelection().brain === model.id) score += 30;
    return score;
  }

  async generate(
    task: ModelTask,
    request: GenerateRequest,
    options: RouteRequirements & {
      signal?: AbortSignal;
      timeoutMs?: number;
      maxAttempts?: number;
      /** How long to wait for an exhausted per-minute quota before failing. */
      maxQuotaWaitMs?: number;
      onQuotaWait?: (modelId: string, waitMs: number) => void;
    } = {},
  ): Promise<GenerateResponse> {
    const requirements: RouteRequirements = {
      ...options,
      vision: options.vision || request.messages.some((message) => message.parts.some((part) => part.type === "image")),
      structuredOutput: options.structuredOutput || Boolean(request.responseSchema),
      tools: options.tools || Boolean(request.tools?.length),
    };
    // Order by readiness BEFORE trimming: models whose quota is exhausted or
    // that are cooling down after overload go last (or are dropped), so a
    // working model further down the ranking is still reached.
    const ranked = this.candidates(task, requirements);
    const maxWait = options.maxQuotaWaitMs ?? 15_000;
    const now = Date.now();
    const readiness = (model: ModelDefinition) => {
      const wait = this.limiter.waitEstimate(model.id);
      const coolingDown = (this.health.get(model.id)?.coolDownUntil ?? 0) > now;
      return wait > maxWait ? 3 : coolingDown ? 2 : wait > 3_000 ? 1 : 0;
    };
    const usable = ranked.filter((model) => readiness(model) < 3);
    if (!usable.length) {
      const soonest = Math.min(...ranked.map((model) => this.limiter.waitEstimate(model.id)));
      const hours = soonest / 3_600_000;
      appEvents.publish("model.status", { kind: "quota_exhausted", models: ranked.map((model) => model.displayName), retryAfterMs: soonest });
      throw new ModelError("RATE_LIMIT", ranked.length === 1
        ? `${ranked[0].displayName}'s quota is used up${hours >= 1 ? ` (resets in about ${Math.round(hours)}h)` : ""}. Pick another model or allow fallback in Settings → AI / Models.`
        : `Every available model is out of quota right now${hours >= 1 ? ` (soonest reset in about ${Math.round(hours)}h)` : ""}.`, { retryable: false, retryAfterMs: soonest });
    }
    const candidates = usable
      .map((model, index) => ({ model, index, ready: readiness(model) }))
      .sort((a, b) => a.ready - b.ready || a.index - b.index)
      .map((item) => item.model)
      .slice(0, 4);
    let lastError: ModelError | null = null;
    for (const [index, model] of candidates.entries()) {
      const adapter = this.registry.adapterFor(model);
      if (!adapter) continue;
      const isLast = index === candidates.length - 1;
      try {
        const response = await withRetry(async () => {
          const quotaWait = isLast ? options.maxQuotaWaitMs ?? 15_000 : 3_000;
          const expected = this.limiter.waitEstimate(model.id);
          if (expected > 1_000 && expected <= quotaWait) options.onQuotaWait?.(model.id, expected);
          const release = await this.limiter.acquire(model.id, options.signal, quotaWait);
          try {
            // A model that is not the last option gets a short leash: an
            // overloaded model can hang for 45 s before failing.
            const timeoutMs = isLast ? options.timeoutMs ?? 60_000 : Math.min(options.timeoutMs ?? 60_000, 20_000);
            return await adapter.generate(model, request, { signal: options.signal, timeoutMs });
          } catch (error) {
            if (error instanceof ModelError && error.code === "RATE_LIMIT") this.learnQuota(model.id, error);
            // An overloaded model ("high demand") rarely recovers within a
            // second; when Auto ranked it and another model is next in line,
            // move on now instead of retrying it. A model the user picked
            // explicitly still gets its bounded retry first.
            const picked = this.registry.getSelection().brain === model.id;
            if (!isLast && !picked && error instanceof ModelError && ["UNAVAILABLE", "SERVER", "TIMEOUT"].includes(error.code)) {
              throw new ModelError(error.code, error.message, { ...error.options, retryable: false });
            }
            throw error;
          } finally {
            release();
          }
        }, {
          maxAttempts: options.maxAttempts ?? 2,
          signal: options.signal,
          maxRetryAfterMs: isLast ? Math.max(20_000, options.maxQuotaWaitMs ?? 0) : 5_000,
          onRetry: (error, attempt, delay) => {
            if (error.code === "RATE_LIMIT") options.onQuotaWait?.(model.id, delay);
            log.warn(`retry ${model.id} after ${error.code}`, { attempt, delay, purpose: request.purpose });
          },
        });
        this.usage.recordSuccess(model.id, request.purpose, response.usage, response.latencyMs);
        this.markHealthy(model.id);
        this.network.markSuccess();
        if (index > 0) {
          appEvents.publish("model.status", { kind: "fallback", using: model.displayName, from: candidates[0].displayName, reason: lastError?.code });
        }
        return response;
      } catch (error) {
        const modelError = error instanceof ModelError ? error : new ModelError("SERVER", String(error), { retryable: false });
        lastError = modelError;
        this.usage.recordFailure(model.id, request.purpose, modelError.code, modelError.message);
        this.markFailure(model.id, modelError);
        if (modelError.code === "NETWORK") await this.network.markNetworkFailure();
        if (modelError.code === "CANCELLED" || !modelError.fallbackEligible) throw modelError;
        log.warn(`model ${model.id} failed (${modelError.code}); ${index + 1 < candidates.length ? "trying next" : "no fallback left"}`);
      }
    }
    throw lastError || new ModelError("UNAVAILABLE", "No model could serve the request.");
  }

  async *stream(task: ModelTask, request: GenerateRequest, options: RouteRequirements & { signal?: AbortSignal; timeoutMs?: number } = {}): AsyncIterable<StreamChunk & { modelId: string }> {
    const [model] = this.candidates(task, { ...options, vision: request.messages.some((m) => m.parts.some((p) => p.type === "image")) });
    const adapter = this.registry.adapterFor(model);
    if (!adapter?.stream) {
      const response = await this.generate(task, request, options);
      yield { textDelta: response.text, done: true, usage: response.usage, modelId: response.modelId };
      return;
    }
    const release = await this.limiter.acquire(model.id, options.signal);
    try {
      for await (const chunk of adapter.stream(model, request, { signal: options.signal, timeoutMs: options.timeoutMs ?? 60_000 })) {
        yield { ...chunk, modelId: model.id };
      }
      this.network.markSuccess();
    } catch (error) {
      const modelError = error instanceof ModelError ? error : new ModelError("SERVER", String(error));
      this.usage.recordFailure(model.id, request.purpose, modelError.code, modelError.message);
      throw modelError;
    } finally {
      release();
    }
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const [model] = this.candidates("embedding");
    const adapter = this.registry.adapterFor(model);
    if (!adapter?.embed) throw new ModelError("NOT_CONFIGURED", "No embedding provider configured.", { retryable: false });
    return adapter.embed(model, texts, { signal, timeoutMs: 20_000 });
  }

  /** One-line connectivity/auth check used by the model selector's "Test" button. */
  async test(modelId: string, signal?: AbortSignal): Promise<{ ok: boolean; latencyMs?: number; error?: string; code?: string }> {
    try {
      const response = await this.generate("conversation", {
        purpose: "model.test",
        messages: [{ role: "user", parts: [{ type: "text", text: "Reply with exactly: ok" }] }],
        maxOutputTokens: 64,
        reasoning: "off",
      }, { modelId, signal, maxAttempts: 1, timeoutMs: 20_000 });
      return { ok: true, latencyMs: response.latencyMs };
    } catch (error) {
      const modelError = error instanceof ModelError ? error : null;
      return { ok: false, error: modelError?.userMessage || String(error), code: modelError?.code };
    }
  }

  healthSnapshot() {
    return Object.fromEntries([...this.health.entries()].map(([id, health]) => [id, {
      recentFailures: health.failures.filter((at) => Date.now() - at < 120_000).length,
      coolingDown: health.coolDownUntil > Date.now(),
    }]));
  }

  private learnQuota(modelId: string, error: ModelError): void {
    if (error.options.quotaPerMinute) this.limiter.setModelLimit(modelId, error.options.quotaPerMinute);
    if (error.options.retryAfterMs) {
      this.limiter.blockUntil(modelId, Date.now() + error.options.retryAfterMs);
      if (error.options.retryAfterMs > 10 * 60_000) {
        const model = this.registry.getModel(modelId);
        appEvents.publish("model.status", { kind: "quota_exhausted", models: [model?.displayName || modelId], retryAfterMs: error.options.retryAfterMs });
        log.warn(`${modelId} quota exhausted for ~${Math.round(error.options.retryAfterMs / 60_000)} min`);
      }
    }
  }

  private markFailure(modelId: string, error: ModelError): void {
    if (error.code === "CANCELLED") return;
    const health = this.health.get(modelId) || { failures: [], coolDownUntil: 0 };
    health.failures.push(Date.now());
    health.failures = health.failures.filter((at) => Date.now() - at < 120_000);
    if (health.failures.length >= 3) {
      health.coolDownUntil = Date.now() + (error.options.retryAfterMs ?? 60_000);
    }
    // "High demand" overloads: skip the model for a while, longer each time
    // it fails again (45 s, 3 min, 8 min), so every planning step does not
    // pay the timeout of a model that is down for the afternoon.
    if (error.code === "UNAVAILABLE" || error.code === "SERVER") {
      const strikes = Math.min(3, (health.overloads ?? 0) + 1);
      health.overloads = strikes;
      health.coolDownUntil = Math.max(health.coolDownUntil, Date.now() + [45_000, 180_000, 480_000][strikes - 1]);
    }
    this.health.set(modelId, health);
  }

  private markHealthy(modelId: string): void {
    this.health.delete(modelId);
  }
}
