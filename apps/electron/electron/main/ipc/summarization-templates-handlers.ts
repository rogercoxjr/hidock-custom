/**
 * Summarization Templates IPC Handlers
 *
 * CRUD over IPC for summarization templates (Phase 2 of summarization-templates plan).
 * latestRun read added in Phase 3 (Task 13b) for reader chip + suggest-new banner.
 * Manual override / resummarize are deferred to Phase 4.
 */

import { ipcMain } from 'electron'
import { success, error, Result } from '../types/api'
import {
  listTemplates,
  createTemplate,
  updateTemplate,
  setEnabled,
  deleteTemplate,
  getTemplateById,
  type SummarizationTemplate
} from '../services/summarization-templates'
import {
  TemplateInputSchema,
  TemplatePatchSchema,
  TemplateIdSchema,
  SetEnabledSchema
} from '../validation/summarization-templates'
import { getLatestTemplateRun, getTranscriptByRecordingId } from '../services/database'
import { hashText } from '../services/summarization-selector'

/** Shape returned by the latestRun IPC to the renderer. */
export interface LatestRunView {
  /** Denormalized template name from the transcript row (null when none was applied). */
  name: string | null
  /** Selection confidence from the last selector run (0-1), or null when no run. */
  confidence: number | null
  /** Selection kind from the last run: 'applied' | 'suggest_new' | 'none' | … */
  kind: string | null
  /** Parsed suggested-template payload when kind === 'suggest_new', else null. */
  suggestedTemplate: Record<string, unknown> | null
  /** True when the template's instructions changed since this summary was generated. */
  instructionsChanged: boolean
}

export function registerSummarizationTemplatesHandlers(): void {
  ipcMain.handle(
    'summarizationTemplates:list',
    async (): Promise<Result<SummarizationTemplate[]>> => {
      try {
        return success(listTemplates())
      } catch (err) {
        return error('INTERNAL_ERROR', 'Failed to list templates', err)
      }
    }
  )

  ipcMain.handle(
    'summarizationTemplates:create',
    async (_, payload: unknown): Promise<Result<SummarizationTemplate>> => {
      const parsed = TemplateInputSchema.safeParse(payload)
      if (!parsed.success) {
        return error('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid template', parsed.error.format())
      }
      try {
        return success(createTemplate(parsed.data))
      } catch (err) {
        return error('INTERNAL_ERROR', err instanceof Error ? err.message : 'Create failed', err)
      }
    }
  )

  ipcMain.handle(
    'summarizationTemplates:update',
    async (_, id: unknown, patch: unknown): Promise<Result<SummarizationTemplate>> => {
      const idP = TemplateIdSchema.safeParse({ id })
      const patchP = TemplatePatchSchema.safeParse(patch)
      if (!idP.success || !patchP.success) {
        return error('VALIDATION_ERROR', 'Invalid update', null)
      }
      try {
        return success(updateTemplate(idP.data.id, patchP.data))
      } catch (err) {
        return error('INTERNAL_ERROR', err instanceof Error ? err.message : 'Update failed', err)
      }
    }
  )

  ipcMain.handle(
    'summarizationTemplates:setEnabled',
    async (_, payload: unknown): Promise<Result<true>> => {
      const parsed = SetEnabledSchema.safeParse(payload)
      if (!parsed.success) {
        return error('VALIDATION_ERROR', 'Invalid request', null)
      }
      try {
        setEnabled(parsed.data.id, parsed.data.enabled)
        return success(true as const)
      } catch (err) {
        return error('INTERNAL_ERROR', err instanceof Error ? err.message : 'Failed', err)
      }
    }
  )

  ipcMain.handle(
    'summarizationTemplates:delete',
    async (_, payload: unknown): Promise<Result<true>> => {
      const parsed = TemplateIdSchema.safeParse(payload)
      if (!parsed.success) {
        return error('VALIDATION_ERROR', 'Invalid request', null)
      }
      try {
        deleteTemplate(parsed.data.id)
        return success(true as const)
      } catch (err) {
        return error('INTERNAL_ERROR', err instanceof Error ? err.message : 'Failed', err)
      }
    }
  )

  /**
   * Phase 3 (Task 13b): Returns provenance data for the reader chip + banner.
   * Reads the transcript's denormalized template name/hash, the most-recent
   * selector run (for confidence + kind + suggestedTemplate), and computes
   * instructionsChanged by comparing the stored hash against the live template.
   */
  ipcMain.handle(
    'summarizationTemplates:latestRun',
    async (_, recordingId: unknown): Promise<Result<LatestRunView>> => {
      if (typeof recordingId !== 'string' || !recordingId) {
        return error('VALIDATION_ERROR', 'recordingId must be a non-empty string', null)
      }
      try {
        const transcript = getTranscriptByRecordingId(recordingId)
        const run = getLatestTemplateRun(recordingId)

        const templateName = transcript?.summarization_template_name ?? null
        const templateHash = transcript?.summarization_template_hash ?? null

        // Compute instructionsChanged: does the live template's instructions hash
        // differ from the hash that was applied when this summary was generated?
        let instructionsChanged = false
        if (templateHash && transcript?.summarization_template_id) {
          const liveTemplate = getTemplateById(transcript.summarization_template_id)
          if (liveTemplate) {
            const liveHash = hashText(liveTemplate.instructions)
            instructionsChanged = liveHash !== templateHash
          }
          // If template was deleted, we can't compare — leave instructionsChanged false.
        }

        // Parse suggestedTemplate JSON (only relevant when kind === 'suggest_new').
        let suggestedTemplate: Record<string, unknown> | null = null
        if (run?.suggestedTemplateJson) {
          try {
            suggestedTemplate = JSON.parse(run.suggestedTemplateJson) as Record<string, unknown>
          } catch {
            suggestedTemplate = null
          }
        }

        const view: LatestRunView = {
          name: templateName,
          confidence: run ? run.selectionConfidence : null,
          kind: run ? run.selectionKind : null,
          suggestedTemplate,
          instructionsChanged,
        }
        return success(view)
      } catch (err) {
        return error('INTERNAL_ERROR', err instanceof Error ? err.message : 'latestRun failed', err)
      }
    }
  )
}
