/**
 * Typed provider errors (auto-pipeline spec §7.1/§7.2).
 * Thrown by ASR/LLM providers; consumed by the queue worker.
 * P4 turns ProviderRateLimitError into "parking" — until then it falls
 * through to the generic retry path (its message is retryable).
 */
export class ProviderRateLimitError extends Error {
  constructor(
    public readonly provider: string,
    public readonly retryAfterMs?: number
  ) {
    super(`${provider} rate limit (HTTP 429)${retryAfterMs ? ` — retry after ${Math.round(retryAfterMs / 1000)}s` : ''}`)
    this.name = 'ProviderRateLimitError'
  }
}

/** Key rejected (401) — terminal until the user re-enters the key (spec §7.1). */
export class ProviderAuthError extends Error {
  constructor(public readonly provider: string) {
    super(`${provider} API key was rejected — re-enter it in Settings`)
    this.name = 'ProviderAuthError'
  }
}
