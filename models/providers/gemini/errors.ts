import { ModelError } from "../../types";

/** Map any Gemini SDK / transport failure onto ABxAG's provider-neutral error codes. */
export function classifyGeminiError(error: unknown, modelId: string, cancelled: boolean, timedOut: boolean): ModelError {
  if (error instanceof ModelError) return error;
  if (cancelled) return new ModelError("CANCELLED", "Model request was cancelled.", { modelId, retryable: false });
  if (timedOut) return new ModelError("TIMEOUT", "Model request timed out.", { modelId });

  const status = typeof (error as { status?: unknown })?.status === "number" ? Number((error as { status: number }).status) : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const retryAfterMs = parseRetryAfter(message);

  if (/aborterror|aborted|the operation was aborted/.test(lower) || (error as Error)?.name === "AbortError") {
    return new ModelError("TIMEOUT", "Model request was aborted before completing.", { modelId });
  }
  if (status === 401 || status === 403 || /api[_ ]?key (not valid|invalid)|api_key_invalid|permission_denied|unauthenticated/.test(lower)) {
    return new ModelError("AUTH", "The Gemini API key was rejected.", { modelId, status, retryable: false });
  }
  if (status === 429 || /resource_exhausted|quota|rate limit|too many requests/.test(lower)) {
    // e.g. "Quota exceeded for metric: …free_tier_requests, limit: 5, model: …"
    const perMinute = /per[_ ]?minute|requests[^,]*,\s*limit/i.test(message) || /free_tier_requests/i.test(message)
      ? Number(message.match(/limit:\s*(\d+)/i)?.[1])
      : NaN;
    const daily = /per[_ ]?day|daily/i.test(message);
    return new ModelError("RATE_LIMIT", daily ? "Gemini daily quota exhausted." : "Gemini rate limit or quota reached.", {
      modelId,
      status,
      retryAfterMs: daily ? Math.max(retryAfterMs ?? 0, 3_600_000) : retryAfterMs,
      quotaPerMinute: Number.isFinite(perMinute) && !daily ? perMinute : undefined,
    });
  }
  if (status === 404 || /not found|is not supported for|unknown model/.test(lower)) {
    return new ModelError("NOT_FOUND", `Model ${modelId} is not available for this key.`, { modelId, status, retryable: false });
  }
  if (status === 400 && /token|context|too long|exceeds the maximum/.test(lower)) {
    return new ModelError("CONTEXT_LIMIT", "The request exceeded the model's context limit.", { modelId, status, retryable: false });
  }
  if (status === 400) {
    return new ModelError("BAD_REQUEST", `Gemini rejected the request: ${message.slice(0, 300)}`, { modelId, status, retryable: false });
  }
  if (status === 503 || /unavailable|overloaded/.test(lower)) {
    return new ModelError("UNAVAILABLE", "Gemini is temporarily unavailable.", { modelId, status, retryAfterMs });
  }
  if (status !== undefined && status >= 500) {
    return new ModelError("SERVER", `Gemini server error (${status}).`, { modelId, status, retryAfterMs });
  }
  if (/fetch failed|enotfound|econnreset|econnrefused|etimedout|eai_again|network|socket hang up|getaddrinfo/.test(lower)) {
    return new ModelError("NETWORK", "Network error while contacting Gemini.", { modelId });
  }
  return new ModelError("SERVER", message.slice(0, 300) || "Unknown Gemini error.", { modelId, retryable: false });
}

function parseRetryAfter(message: string): number | undefined {
  const match = message.match(/retry(?:\s+in|Delay"?\s*:\s*"?)\s*([\d.]+)\s*(ms|s)?/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return match[2]?.toLowerCase() === "ms" ? value : value * 1000;
}

