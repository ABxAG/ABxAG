/**
 * Client-side rate limiting per model: a sliding one-minute request window
 * plus a concurrency cap. Waiting is cancellable and bounded; when the wait
 * would exceed `maxWaitMs` a RATE_LIMIT error is raised locally instead.
 */
import { ModelError } from "./types";

export class ModelRateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly inFlight = new Map<string, number>();
  /** Per-model requests-per-minute learned from provider quota errors or config. */
  private readonly perModelRpm = new Map<string, number>();
  private readonly blockedUntil = new Map<string, number>();

  constructor(
    private readonly limits: { requestsPerMinute: number; concurrency: number; maxWaitMs: number } = {
      requestsPerMinute: 30,
      concurrency: 4,
      maxWaitMs: 15_000,
    },
    private readonly now: () => number = Date.now,
  ) {}

  /** Adopt a provider-reported quota (e.g. a free tier's 5 requests/minute). */
  setModelLimit(modelId: string, requestsPerMinute: number): void {
    if (Number.isFinite(requestsPerMinute) && requestsPerMinute > 0) {
      this.perModelRpm.set(modelId, Math.max(1, Math.floor(requestsPerMinute)));
    }
  }

  /** The provider asked us to back off until `at`. */
  blockUntil(modelId: string, at: number): void {
    this.blockedUntil.set(modelId, Math.max(this.blockedUntil.get(modelId) || 0, at));
  }

  /** Milliseconds until a request to this model could start (0 = now). */
  waitEstimate(modelId: string): number {
    const blocked = Math.max(0, (this.blockedUntil.get(modelId) || 0) - this.now());
    const window = this.prune(modelId);
    const rpm = this.rpm(modelId);
    const windowWait = window.length >= rpm ? window[window.length - rpm] + 60_000 - this.now() : 0;
    return Math.max(blocked, windowWait);
  }

  private rpm(modelId: string): number {
    return this.perModelRpm.get(modelId) ?? this.limits.requestsPerMinute;
  }

  async acquire(modelId: string, signal?: AbortSignal, maxWaitMs = this.limits.maxWaitMs): Promise<() => void> {
    const started = this.now();
    for (;;) {
      if (signal?.aborted) throw new ModelError("CANCELLED", "Cancelled.", { retryable: false });
      const window = this.prune(modelId);
      const active = this.inFlight.get(modelId) || 0;
      const blocked = Math.max(0, (this.blockedUntil.get(modelId) || 0) - this.now());
      if (blocked === 0 && window.length < this.rpm(modelId) && active < this.limits.concurrency) {
        window.push(this.now());
        this.inFlight.set(modelId, active + 1);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.inFlight.set(modelId, Math.max(0, (this.inFlight.get(modelId) || 1) - 1));
        };
      }
      const rpm = this.rpm(modelId);
      const waitForWindow = Math.max(
        blocked,
        window.length >= rpm ? window[window.length - rpm] + 60_000 - this.now() : 150,
      );
      if (this.now() - started + waitForWindow > maxWaitMs) {
        throw new ModelError("RATE_LIMIT", `Local rate limit for ${modelId} reached.`, { retryAfterMs: waitForWindow, modelId });
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(50, Math.min(waitForWindow, 500))));
    }
  }

  snapshot(): Record<string, { lastMinute: number; inFlight: number; rpm: number; waitMs: number }> {
    const out: Record<string, { lastMinute: number; inFlight: number; rpm: number; waitMs: number }> = {};
    for (const key of new Set([...this.windows.keys(), ...this.inFlight.keys(), ...this.perModelRpm.keys()])) {
      out[key] = { lastMinute: this.prune(key).length, inFlight: this.inFlight.get(key) || 0, rpm: this.rpm(key), waitMs: this.waitEstimate(key) };
    }
    return out;
  }

  private prune(modelId: string): number[] {
    const cutoff = this.now() - 60_000;
    const window = this.windows.get(modelId) || [];
    while (window.length && window[0] < cutoff) window.shift();
    this.windows.set(modelId, window);
    return window;
  }
}
