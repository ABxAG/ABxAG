/** Per-model and per-purpose usage accounting for the developer view. */
import type { ModelErrorCode, Usage } from "./types";

export interface ModelUsageStats {
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalLatencyMs: number;
  lastUsedAt: string | null;
  lastError: { code: ModelErrorCode; message: string; at: string } | null;
}

function empty(): ModelUsageStats {
  return {
    calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    totalLatencyMs: 0, lastUsedAt: null, lastError: null,
  };
}

export class UsageTracker {
  private readonly byModel = new Map<string, ModelUsageStats>();
  private readonly byPurpose = new Map<string, ModelUsageStats>();

  recordSuccess(modelId: string, purpose: string, usage: Usage, latencyMs: number): void {
    for (const stats of [this.get(this.byModel, modelId), this.get(this.byPurpose, purpose)]) {
      stats.calls += 1;
      stats.inputTokens += usage.inputTokens;
      stats.outputTokens += usage.outputTokens;
      stats.reasoningTokens += usage.reasoningTokens;
      stats.totalLatencyMs += latencyMs;
      stats.lastUsedAt = new Date().toISOString();
    }
  }

  recordFailure(modelId: string, purpose: string, code: ModelErrorCode, message: string): void {
    const at = new Date().toISOString();
    for (const stats of [this.get(this.byModel, modelId), this.get(this.byPurpose, purpose)]) {
      stats.calls += 1;
      stats.failures += 1;
      stats.lastError = { code, message: message.slice(0, 200), at };
      stats.lastUsedAt = at;
    }
  }

  snapshot() {
    const view = (map: Map<string, ModelUsageStats>) => Object.fromEntries(
      [...map.entries()].map(([key, stats]) => [key, {
        ...stats,
        avgLatencyMs: stats.calls - stats.failures > 0 ? Math.round(stats.totalLatencyMs / (stats.calls - stats.failures)) : null,
      }]),
    );
    return { models: view(this.byModel), purposes: view(this.byPurpose) };
  }

  private get(map: Map<string, ModelUsageStats>, key: string): ModelUsageStats {
    let stats = map.get(key);
    if (!stats) {
      stats = empty();
      map.set(key, stats);
    }
    return stats;
  }
}
