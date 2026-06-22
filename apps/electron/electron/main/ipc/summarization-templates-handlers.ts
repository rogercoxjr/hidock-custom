/**
 * Summarization Templates IPC Handlers
 *
 * CRUD over IPC for summarization templates (Phase 2 of summarization-templates plan).
 * latestRun read added in Phase 3 (Task 13b) for reader chip + suggest-new banner.
 * previewSelection + acceptSuggestedTemplate added in Phase 4 (Task 14).
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
  userTemplates,
  type SummarizationTemplate,
  type TemplateInput
} from '../services/summarization-templates'
import {
  TemplateInputSchema,
  TemplatePatchSchema,
  TemplateIdSchema,
  SetEnabledSchema
} from '../validation/summarization-templates'
import {
  getLatestTemplateRun,
  getTranscriptByRecordingId,
  setTranscriptTemplateOverride,
  clearTranscriptStage2Marker,
  hasInFlightQueueItem,
  addToQueue
} from '../services/database'
import { hashText, selectTemplateForTranscript, type TemplateSelectionResult } from '../services/summarization-selector'
import { getConfig } from '../services/config'
import { getLlmProvider } from '../services/llm/llm-provider'
import { processQueueManually } from '../services/transcription'

// ---------------------------------------------------------------------------
// Phase 4 (Task 14): Rate limiter for previewSelection (mirrors outputs-handlers)
// Global key so 5/min is a true ceiling across ALL recordings (spec §5.1 cost-control).
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 5
const previewTimestamps: Map<string, number[]> = new Map()

/**
 * Check and enforce rate limit for a given key.
 * Returns true if the request is allowed, false if rate-limited.
 */
function checkRateLimit(key: string): boolean {
  const now = Date.now()
  const timestamps = previewTimestamps.get(key) || []
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    previewTimestamps.set(key, recent)
    return false
  }
  recent.push(now)
  previewTimestamps.set(key, recent)
  return true
}

/** Shape returned by previewSelection IPC to the renderer. */
export type PreviewSelectionResult = TemplateSelectionResult & { elapsedMs: number }

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

  /**
   * Phase 4 (Task 14): previewSelection — READ-ONLY selector dry-run.
   *
   * Runs selectTemplateForTranscript for the given recording and returns the
   * TemplateSelectionResult WITHOUT writing anything to the DB (no audit row,
   * no override).  Rate-limited at 5/min globally across all recordingIds
   * (spec §5.1 cost-control).
   */
  ipcMain.handle(
    'summarizationTemplates:previewSelection',
    async (_, recordingId: unknown): Promise<Result<PreviewSelectionResult>> => {
      if (typeof recordingId !== 'string' || !recordingId) {
        return error('VALIDATION_ERROR', 'recordingId must be a non-empty string', null)
      }
      // Global rate limit — not per recording (spec §5.1)
      if (!checkRateLimit('previewSelection')) {
        return error(
          'RATE_LIMITED',
          'Rate limit exceeded. Maximum 5 preview selections per minute. Please wait before trying again.'
        )
      }
      try {
        const transcript = getTranscriptByRecordingId(recordingId)
        if (!transcript?.full_text) {
          return error('NOT_FOUND', 'No transcript text available for this recording', null)
        }
        const templates = userTemplates()
        const config = getConfig()
        const llm = getLlmProvider(config)
        // Deliberate read-only-preview simplification: meetingSubjects=[] and
        // userDefaultId=null. The preview only exercises the selector against the
        // transcript text; it intentionally does NOT resolve the real default template
        // or meeting context (that full resolution happens in the live Stage-2 path).
        const result = await selectTemplateForTranscript(
          {
            fullText: transcript.full_text,
            meetingSubjects: [],
            templates,
            userDefaultId: null,
          },
          llm
        )
        return success(result)
      } catch (err) {
        return error('INTERNAL_ERROR', err instanceof Error ? err.message : 'previewSelection failed', err)
      }
    }
  )

  /**
   * Phase 4 (Task 14): acceptSuggestedTemplate — save + re-summarize.
   *
   * Reads the latest run's suggested_template_json for recordingId, merges any
   * caller-supplied `edits` (name/description/instructions/exampleTriggers) over it,
   * creates a new user template via createTemplate (sanitized, is_builtin=0 enforced),
   * then re-summarizes the recording with the newly-created template id by calling
   * setTranscriptTemplateOverride + clearTranscriptStage2Marker + addToQueue.
   * Rejects with { success: false } when a transcription job is already in-flight.
   */
  ipcMain.handle(
    'summarizationTemplates:acceptSuggestedTemplate',
    async (_, recordingId: unknown, edits?: unknown): Promise<Result<SummarizationTemplate>> => {
      if (typeof recordingId !== 'string' || !recordingId) {
        return error('VALIDATION_ERROR', 'recordingId must be a non-empty string', null)
      }
      try {
        // §8.3 concurrency guard — check in-flight FIRST, before creating the template,
        // so a rejected (in-flight) request never orphans a freshly-created template row
        // in the user's list. Mirrors the guard-before-write order of resummarizeWithTemplate.
        if (hasInFlightQueueItem(recordingId)) {
          return error('VALIDATION_ERROR', 'transcription in progress', null)
        }

        // Read the suggested template from the latest selector run
        const run = getLatestTemplateRun(recordingId)
        if (!run?.suggestedTemplateJson) {
          return error(
            'NOT_FOUND',
            'No suggested template found for this recording. Run the selector first.',
            null
          )
        }

        let suggestedPayload: Record<string, unknown>
        try {
          suggestedPayload = JSON.parse(run.suggestedTemplateJson) as Record<string, unknown>
        } catch {
          return error('INTERNAL_ERROR', 'Could not parse suggested template JSON', null)
        }

        // Merge optional caller edits over the suggested payload
        const editObj = edits && typeof edits === 'object' && !Array.isArray(edits)
          ? (edits as Record<string, unknown>)
          : {}

        const mergedInput: TemplateInput = {
          name: typeof editObj.name === 'string'
            ? editObj.name
            : typeof suggestedPayload.name === 'string' ? suggestedPayload.name : 'Suggested template',
          description: typeof editObj.description === 'string'
            ? editObj.description
            : typeof suggestedPayload.description === 'string' ? suggestedPayload.description : undefined,
          instructions: typeof editObj.instructions === 'string'
            ? editObj.instructions
            : typeof suggestedPayload.instructions === 'string'
              ? suggestedPayload.instructions
              : typeof suggestedPayload.guidance === 'string'
                ? suggestedPayload.guidance
                : '',
          exampleTriggers: Array.isArray(editObj.exampleTriggers)
            ? (editObj.exampleTriggers as unknown[]).filter((t): t is string => typeof t === 'string')
            : Array.isArray(suggestedPayload.exampleTriggers)
              ? (suggestedPayload.exampleTriggers as unknown[]).filter((t): t is string => typeof t === 'string')
              : [],
        }

        // Create the new user template (sanitize forces is_builtin=0). Safe to write
        // now that the in-flight guard above has passed.
        const newTemplate = createTemplate(mergedInput)

        // Write the single-shot override and enqueue a re-summarize
        setTranscriptTemplateOverride(recordingId, newTemplate.id)
        clearTranscriptStage2Marker(recordingId)

        // Enqueue asynchronously (mirrors recording-handlers resummarize path)
        addToQueue(recordingId)
        void processQueueManually()

        return success(newTemplate)
      } catch (err) {
        return error('INTERNAL_ERROR', err instanceof Error ? err.message : 'acceptSuggestedTemplate failed', err)
      }
    }
  )
}
