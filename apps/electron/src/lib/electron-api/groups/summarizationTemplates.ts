/**
 * summarizationTemplates.ts — REST SDK group for the summarizationTemplates namespace.
 *
 * Per CONTRACTS.md (Summarization Templates table):
 *
 *   RESULT (error synthesized as {message,details?}):
 *     list, create, update, setEnabled, delete, latestRun,
 *     previewSelection, acceptSuggestedTemplate
 *
 *   INLINE ({success, error?}):
 *     resummarizeWithTemplate
 *
 * ERROR-OBJECT SYNTHESIS (CONTRACTS §error-detail):
 *   result.error = { message: r.error, details: (r.data as any)?.details }
 *   Call sites read `(res as FailResult).error?.message`.
 */

import type { Http } from '../http'
import type { Result } from '../types'
import type {
  SummarizationTemplate,
  TemplateInput,
  LatestRunView,
  PreviewSelectionResult,
  SuggestedTemplateEdits,
} from '../types'

export interface SummarizationTemplatesDeps {
  http: Http
}

/** Synthesise an error object for call sites that read `result.error?.message`. */
function errObj(r: { error?: string; data?: unknown }): { message: string; details?: unknown } {
  return {
    message: r.error ?? 'Unknown error',
    details: (r.data as any)?.details,
  }
}

export function makeSummarizationTemplatesGroup({ http }: SummarizationTemplatesDeps) {
  return {
    // -------------------------------------------------------------------------
    // RESULT (error as {message, details?})
    // -------------------------------------------------------------------------

    async list(): Promise<Result<SummarizationTemplate[]>> {
      const r = await http.get('/api/summarization-templates')
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as SummarizationTemplate[] }
    },

    async create(template: TemplateInput): Promise<Result<SummarizationTemplate>> {
      const r = await http.post('/api/summarization-templates', template)
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as SummarizationTemplate }
    },

    async update(
      id: string,
      patch: Partial<TemplateInput>,
    ): Promise<Result<SummarizationTemplate>> {
      const r = await http.patch(`/api/summarization-templates/${id}`, patch)
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as SummarizationTemplate }
    },

    async setEnabled(id: string, enabled: boolean): Promise<Result<true>> {
      const r = await http.patch(`/api/summarization-templates/${id}`, { enabled })
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: true }
    },

    async delete(id: string): Promise<Result<true>> {
      const r = await http.del(`/api/summarization-templates/${id}`)
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: true }
    },

    async latestRun(recordingId: string): Promise<Result<LatestRunView>> {
      const r = await http.get(`/api/recordings/${recordingId}/template-run`)
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as LatestRunView }
    },

    async previewSelection(recordingId: string): Promise<Result<PreviewSelectionResult>> {
      const r = await http.get(`/api/recordings/${recordingId}/template-selection`)
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as PreviewSelectionResult }
    },

    async acceptSuggestedTemplate(
      recordingId: string,
      edits?: SuggestedTemplateEdits,
    ): Promise<Result<SummarizationTemplate>> {
      const r = await http.post(
        `/api/recordings/${recordingId}/accept-suggested-template`,
        edits ?? {},
      )
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as SummarizationTemplate }
    },

    // -------------------------------------------------------------------------
    // INLINE: {success, error?}  (NOT generic Result<T>)
    // -------------------------------------------------------------------------

    async resummarizeWithTemplate(
      recordingId: string,
      templateId: string | null,
    ): Promise<{ success: boolean; error?: string }> {
      const r = await http.post(`/api/recordings/${recordingId}/resummarize`, { templateId })
      if (!r.ok) {
        return { success: false, error: r.error ?? `HTTP ${r.status}` }
      }
      return { success: true }
    },
  }
}

export type SummarizationTemplatesGroup = ReturnType<typeof makeSummarizationTemplatesGroup>
