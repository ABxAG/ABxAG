/**
 * Bounded retry with exponential backoff and jitter. Never infinite: a
 * server-requested delay longer than `maxRetryAfterMs` ends retrying so the
 * router can fall back to another model (when the user allows fallback).
 */
import { ModelError } from "./types";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetryAfterMs?: number;
  signal?: AbortSignal;
  onRetry?: (error: ModelError, attempt: number, delayMs: number) => void;
  random?: () => number;
}

export async function withRetry<T>(work: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, Math.min(5, options.maxAttempts ?? 3));
  const base = options.baseDelayMs ?? 600;
  const maxDelay = options.maxDelayMs ?? 8_000;
  const maxRetryAfter = options.maxRetryAfterMs ?? 20_000;
  const random = options.random ?? Math.random;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw new ModelError("CANCELLED", "Cancelled.", { retryable: false });
    try {
      return await work(attempt);
    } catch (error) {
      lastError = error;
      if (!(error instanceof ModelError) || !error.retryable || attempt >= maxAttempts) throw error;
      const requested = error.options.retryAfterMs;
      if (requested !== undefined && requested > maxRetryAfter) throw error;
      const backoff = Math.min(maxDelay, base * 2 ** (attempt - 1));
      const delay = Math.round(requested ?? backoff * (0.7 + random() * 0.6));
      options.onRetry?.(error, attempt, delay);
      await sleep(delay, options.signal);
    }
  }
  throw lastError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ModelError("CANCELLED", "Cancelled.", { retryable: false }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
