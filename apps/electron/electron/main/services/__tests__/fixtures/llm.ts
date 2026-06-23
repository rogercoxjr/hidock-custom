import { vi } from 'vitest'
import type { LlmProvider } from '../../llm/llm-provider'

/**
 * Content-routed fake: returns a structured sermon summary when the prompt carries
 * the reframed template contract (SUMMARY & EMPHASIS INSTRUCTIONS); otherwise a
 * generic 2-line summary.
 *
 * Both paths include `selected_meeting_id` and `meeting_confidence` so
 * validateAnalysis passes when candidate meetings are present (hasCandidates: true).
 */
export function makeFakeLlm(): LlmProvider {
  return {
    generate: vi.fn(async (prompt: string) => {
      const structured = prompt.includes('SUMMARY & EMPHASIS INSTRUCTIONS')
      const summary = structured
        ? '## Scripture\nRomans 8:28\n\n## Main Points\n- God works for good\n\n## Application\nReflect daily.'
        : 'Generic two sentence summary. Another sentence.'
      return JSON.stringify({
        summary,
        action_items: ['Reflect daily on Romans 8:28'],
        topics: ['faith'],
        key_points: ['God works for good'],
        title_suggestion: 'Sermon on Romans 8',
        question_suggestions: ['What is the main point?', 'How to apply it?'],
        language: 'en',
        selected_meeting_id: 'none',
        meeting_confidence: 0,
      })
    }),
  }
}
