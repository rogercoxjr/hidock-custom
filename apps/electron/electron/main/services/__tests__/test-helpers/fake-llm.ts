/**
 * Content-routed FakeLlmProvider for Tasks 12 + 15.
 *
 * Routes the `generate(prompt)` call to the correct handler by matching
 * STABLE, UNIQUE anchor strings present in each prompt type:
 *
 *   selector    → prompt contains 'runnerup_confidence'
 *                 (only the selector-contract JSON schema names this key)
 *   actionables → prompt contains 'detect if the speaker intends to create any outputs'
 *                 (transcription.ts detectActionables prompt anchor)
 *   analysis    → prompt starts with 'Analyze this meeting transcript and provide'
 *                 (the no-template and template paths both emit this prefix)
 *
 * Exactly ONE anchor must match; if 0 or 2+ match the fake throws immediately
 * so routing regressions surface loudly rather than silently returning wrong data.
 *
 * Usage:
 *   const fake = makeFakeLlm({
 *     onSelector: (prompt) => JSON.stringify({ template_id: 'tpl_1', confidence: 0.9, ... }),
 *     onAnalysis:  (prompt) => '{"summary": "test", ...}',
 *   })
 */

import type { LlmProvider } from '../../llm/llm-provider'

export interface FakeRoutes {
  /** Called when the prompt is a selector prompt (contains 'runnerup_confidence'). */
  onSelector?: (prompt: string) => string
  /** Called when the prompt is the Stage-2 analysis prompt. */
  onAnalysis?: (prompt: string) => string
  /** Called when the prompt is the actionables-detection prompt. */
  onActionables?: (prompt: string) => string
}

/**
 * Unique, collision-free anchors verified against current prompt texts:
 *   analysis      → 'Analyze this meeting transcript and provide'  (summarization-prompt.ts + transcription.ts)
 *   actionables   → 'detect if the speaker intends to create any outputs'  (transcription.ts)
 *   selector      → 'runnerup_confidence'  (only the selector-contract JSON schema names this key)
 */
export function makeFakeLlm(routes: FakeRoutes): LlmProvider {
  return {
    generate: async (prompt: string) => {
      const isSelector    = prompt.includes('runnerup_confidence')
      const isActionables = prompt.includes('detect if the speaker intends to create any outputs')
      const isAnalysis    = !isSelector && !isActionables && prompt.includes('Analyze this meeting transcript and provide')

      const matched = [isSelector, isActionables, isAnalysis].filter(Boolean).length
      if (matched !== 1) {
        throw new Error(
          `fake-llm routing: ${matched} matchers fired (expected 1).\n` +
          `isSelector=${isSelector}, isActionables=${isActionables}, isAnalysis=${isAnalysis}\n` +
          `Prompt prefix: ${prompt.slice(0, 120)}`
        )
      }

      if (isSelector)    return (routes.onSelector    ?? (() => '{}'))(prompt)
      if (isActionables) return (routes.onActionables ?? (() => '[]'))(prompt)
      return              (routes.onAnalysis           ?? (() => '{}'))(prompt)
    }
  }
}
