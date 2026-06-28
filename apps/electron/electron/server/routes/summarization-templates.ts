import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  listTemplates,
  createTemplate,
  updateTemplate,
  setEnabled,
  deleteTemplate,
  getTemplateById,
  userTemplates
} from '../../main/services/summarization-templates'
import {
  getLatestTemplateRun,
  getTranscriptByRecordingId,
  setTranscriptTemplateOverride,
  clearTranscriptStage2Marker,
  addToQueue
} from '../../main/services/database'
import { hashText, selectTemplateForTranscript } from '../../main/services/summarization-selector'
import { getConfig } from '../../main/services/config'
import { getLlmProvider } from '../../main/services/llm/llm-provider'
import { NotFoundError, BadRequestError } from './_errors'

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const createBody = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  instructions: z.string().min(1).max(2000),
  exampleTriggers: z.array(z.string().max(80)).max(12).optional(),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().optional()
})

const patchBody = createBody.partial()

// Zod schema for the optional edit overlay accepted by
// POST /api/recordings/:id/accept-suggested-template.
// All fields are optional (the suggested template supplies defaults) but must
// satisfy the same bounds as createBody when present — ensures structured 400
// errors with field-level detail instead of bubbling up from createTemplate().
const acceptSuggestedEditBody = createBody.partial()

// ---------------------------------------------------------------------------
// Rate limiter for previewSelection — 5/min globally (spec §5.1)
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 5
const previewTimestamps: number[] = []

function checkPreviewRateLimit(): boolean {
  const now = Date.now()
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  // Evict stale timestamps in-place
  while (previewTimestamps.length > 0 && previewTimestamps[0] < cutoff) {
    previewTimestamps.shift()
  }
  if (previewTimestamps.length >= RATE_LIMIT_MAX_REQUESTS) return false
  previewTimestamps.push(now)
  return true
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function registerSummarizationTemplates(app: FastifyInstance): Promise<void> {
  // --- CRUD over templates ---

  // GET /api/summarization-templates
  app.get('/api/summarization-templates', { preHandler: [app.requireAuth] }, async () => {
    return listTemplates()
  })

  // POST /api/summarization-templates
  app.post('/api/summarization-templates', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req, reply) => {
    const body = createBody.parse(req.body)
    try {
      const template = createTemplate(body)
      return reply.code(201).send(template)
    } catch (err) {
      throw new BadRequestError(err instanceof Error ? err.message : 'Create failed')
    }
  })

  // PATCH /api/summarization-templates/:id  (update fields + handles {enabled} for setEnabled)
  app.patch('/api/summarization-templates/:id', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { id } = req.params as { id: string }
    if (!getTemplateById(id)) throw new NotFoundError('template not found')

    const body = patchBody.parse(req.body)

    // If only `enabled` is provided, delegate to setEnabled (mutates one column);
    // otherwise full updateTemplate (which also handles enabled within the patch).
    if (Object.keys(body).length === 1 && 'enabled' in body && body.enabled !== undefined) {
      try {
        setEnabled(id, body.enabled)
      } catch (err) {
        throw new BadRequestError(err instanceof Error ? err.message : 'setEnabled failed')
      }
      return getTemplateById(id)
    }

    try {
      return updateTemplate(id, body)
    } catch (err) {
      throw new BadRequestError(err instanceof Error ? err.message : 'Update failed')
    }
  })

  // DELETE /api/summarization-templates/:id
  app.delete('/api/summarization-templates/:id', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { id } = req.params as { id: string }
    if (!getTemplateById(id)) throw new NotFoundError('template not found')
    try {
      deleteTemplate(id)
    } catch (err) {
      throw new BadRequestError(err instanceof Error ? err.message : 'Delete failed')
    }
    return { ok: true }
  })

  // --- Per-recording template operations ---

  // GET /api/recordings/:id/template-run  — latest selector run provenance
  app.get('/api/recordings/:id/template-run', { preHandler: [app.requireAuth] }, async (req) => {
    const { id: recordingId } = req.params as { id: string }
    const transcript = getTranscriptByRecordingId(recordingId)
    const run = getLatestTemplateRun(recordingId)

    const templateName = transcript?.summarization_template_name ?? null
    const templateHash = transcript?.summarization_template_hash ?? null

    let instructionsChanged = false
    if (templateHash && transcript?.summarization_template_id) {
      const liveTemplate = getTemplateById(transcript.summarization_template_id)
      if (liveTemplate) {
        instructionsChanged = hashText(liveTemplate.instructions) !== templateHash
      }
    }

    let suggestedTemplate: Record<string, unknown> | null = null
    if (run?.suggestedTemplateJson) {
      try {
        suggestedTemplate = JSON.parse(run.suggestedTemplateJson) as Record<string, unknown>
      } catch {
        suggestedTemplate = null
      }
    }

    return {
      name: templateName,
      confidence: run ? run.selectionConfidence : null,
      kind: run ? run.selectionKind : null,
      suggestedTemplate,
      instructionsChanged
    }
  })

  // GET /api/recordings/:id/template-selection  — read-only selector dry-run (rate-limited)
  app.get('/api/recordings/:id/template-selection', { preHandler: [app.requireAuth] }, async (req) => {
    const { id: recordingId } = req.params as { id: string }

    if (!checkPreviewRateLimit()) {
      throw new BadRequestError('Rate limit exceeded. Maximum 5 preview selections per minute.')
    }

    const transcript = getTranscriptByRecordingId(recordingId)
    if (!transcript?.full_text) {
      throw new NotFoundError('No transcript text available for this recording')
    }

    const templates = userTemplates()
    const config = getConfig()
    const llm = getLlmProvider(config)

    const t0 = Date.now()
    const result = await selectTemplateForTranscript(
      { fullText: transcript.full_text, meetingSubjects: [], templates, userDefaultId: null },
      llm
    )
    return { ...result, elapsedMs: Date.now() - t0 }
  })

  // POST /api/recordings/:id/accept-suggested-template  — save suggested + re-summarize
  app.post(
    '/api/recordings/:id/accept-suggested-template',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req, reply) => {
      const { id: recordingId } = req.params as { id: string }

      // Parse + validate the optional edit overlay up-front.  All fields are
      // optional (the suggested template provides defaults), but any supplied field
      // must satisfy the same bounds as createBody — produces a structured 400 with
      // field-level Zod detail instead of bubbling up from createTemplate().
      const editObj = acceptSuggestedEditBody.parse(req.body ?? {})

      // §8.3 transcript-existence guard
      const existingTranscript = getTranscriptByRecordingId(recordingId)
      if (!existingTranscript?.full_text?.trim()) {
        throw new BadRequestError('No transcript to summarize yet — transcribe this recording first.')
      }

      const run = getLatestTemplateRun(recordingId)
      if (!run?.suggestedTemplateJson) {
        throw new NotFoundError('No suggested template found for this recording. Run the selector first.')
      }

      let suggestedPayload: Record<string, unknown>
      try {
        suggestedPayload = JSON.parse(run.suggestedTemplateJson) as Record<string, unknown>
      } catch {
        throw new BadRequestError('Could not parse suggested template JSON')
      }

      const mergedInput = {
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
          ? editObj.exampleTriggers.filter((t): t is string => typeof t === 'string')
          : Array.isArray(suggestedPayload.exampleTriggers)
            ? (suggestedPayload.exampleTriggers as unknown[]).filter((t): t is string => typeof t === 'string')
            : []
      }

      let newTemplate
      try {
        newTemplate = createTemplate(mergedInput)
      } catch (err) {
        throw new BadRequestError(err instanceof Error ? err.message : 'Create template failed')
      }

      setTranscriptTemplateOverride(recordingId, newTemplate.id)
      clearTranscriptStage2Marker(recordingId)
      addToQueue(recordingId)
      // Fire-and-forget re-summarize (mirrors IPC handler)
      import('../../main/services/transcription')
        .then(({ processQueueManually }) => {
          processQueueManually().catch((err: unknown) => {
            console.error('[accept-suggested-template] processQueueManually error:', err)
          })
        })
        .catch((err: unknown) => {
          console.error('[accept-suggested-template] Failed to import transcription service:', err)
        })

      return reply.code(201).send(newTemplate)
    }
  )
}
