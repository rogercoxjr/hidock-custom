import type { AppConfig } from '../config'
import { createGeminiLlm } from './gemini-llm'

export interface LlmProvider {
  generate(prompt: string, opts?: { json?: boolean }): Promise<string>
}

/** Factory for the analysis/summarization stage. P1 supports 'gemini' only
 *  (config.summarization does not exist until P3 — default to gemini).
 *  Throws when the selected provider's key is missing — this IS the
 *  Stage-2 key check (spec §5.3). */
export function getLlmProvider(config: AppConfig): LlmProvider {
  const provider = (config as { summarization?: { provider?: string } }).summarization?.provider ?? 'gemini'
  switch (provider) {
    case 'gemini':
      return createGeminiLlm(config)
    default:
      throw new Error(`Unknown summarization provider: ${provider}`)
  }
}
