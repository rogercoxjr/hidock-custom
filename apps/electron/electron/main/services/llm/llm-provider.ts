import type { AppConfig } from '../config'
import { createGeminiLlm } from './gemini-llm'

export interface LlmProvider {
  /** opts.json is a HINT only (providers that support a JSON mode may use it;
   *  gemini ignores it) — callers must still parse/validate output defensively. */
  generate(prompt: string, opts?: { json?: boolean }): Promise<string>
}

/** Factory for the analysis/summarization stage. Switches on config.summarization.provider
 *  (added in P3 — config.summarization is now part of AppConfig).
 *  Throws when the selected provider's key is missing — this IS the
 *  Stage-2 key check (spec §5.3). */
export function getLlmProvider(config: AppConfig): LlmProvider {
  const provider = config.summarization?.provider ?? 'gemini'
  switch (provider) {
    case 'gemini':
      return createGeminiLlm(config)
    default:
      throw new Error(`Unknown summarization provider: ${provider}`)
  }
}
