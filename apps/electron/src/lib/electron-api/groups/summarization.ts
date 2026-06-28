/**
 * summarization.ts — REST SDK group for the summarization namespace.
 *
 * Per CONTRACTS.md (Top-level App / Config / Summarization table):
 *
 *   INLINE:
 *     listModels → {success, models?, error?}
 *     testConnection → {success, error?}
 *
 * NOTE: These are INLINE (not generic Result<T>) — the call sites at
 *   Settings.tsx:491,510 read the exact field shape above.
 *   Zod `details` from 4xx are valuable for these (validation messages).
 */

import type { Http } from '../http'

export interface SummarizationDeps {
  http: Http
}

export function makeSummarizationGroup({ http }: SummarizationDeps) {
  return {
    // -------------------------------------------------------------------------
    // INLINE: {success, models?, error?}
    // -------------------------------------------------------------------------

    async listModels(
      apiKey?: string,
    ): Promise<{ success: boolean; models?: string[]; error?: string }> {
      const params = new URLSearchParams()
      if (apiKey !== undefined) params.set('apiKey', apiKey)
      const qs = params.toString()
      const r = await http.get(`/api/summarization/models${qs ? `?${qs}` : ''}`)
      if (!r.ok) {
        // Surface Zod details in the error string when present.
        const details = (r.data as any)?.details
        const errorMsg = details
          ? `${r.error ?? 'Unknown error'}: ${JSON.stringify(details)}`
          : (r.error ?? 'Unknown error')
        return { success: false, error: errorMsg }
      }
      const body = r.data as any
      return { success: true, models: body?.models ?? body }
    },

    // -------------------------------------------------------------------------
    // INLINE: {success, error?}
    // -------------------------------------------------------------------------

    async testConnection(
      apiKey?: string,
      model?: string,
    ): Promise<{ success: boolean; error?: string }> {
      const body: Record<string, unknown> = {}
      if (apiKey !== undefined) body.apiKey = apiKey
      if (model !== undefined) body.model = model
      const r = await http.post('/api/summarization/test-connection', body)
      if (!r.ok) {
        const details = (r.data as any)?.details
        const errorMsg = details
          ? `${r.error ?? 'Unknown error'}: ${JSON.stringify(details)}`
          : (r.error ?? 'Unknown error')
        return { success: false, error: errorMsg }
      }
      return { success: true }
    },
  }
}

export type SummarizationGroup = ReturnType<typeof makeSummarizationGroup>
