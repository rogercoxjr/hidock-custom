/**
 * Transcripts REST router (0c-2b)
 *
 * Covers:
 *   GET  /api/recordings/:id/transcript               (by recording)
 *   POST /api/transcripts/by-recording-ids            ({ids} → map)
 *   GET  /api/transcripts/search?q=                   (full-text search)
 *   PATCH /api/recordings/:id/transcript/turns        ({turns})
 *   POST /api/recordings/:id/transcript/export?format=  (browser download)
 *   POST /api/recordings/:id/transcribe               (queue + kick processor)
 *   POST /api/recordings/:id/resummarize              ({templateId?})
 *   GET  /api/recordings/:id/summary-stale
 *   POST /api/recordings/:id/transcription/cancel
 *   POST /api/recordings/:id/transcription/retry
 *   GET  /api/queue?status=
 *   PATCH /api/queue/:id                              ({status, errorMessage?})
 *   POST /api/queue/process
 *   POST /api/queue/cancel-all
 *   POST /api/queue/retry-failed
 *   GET  /api/queue/status
 *   POST /api/queue/processor/start
 *   POST /api/queue/processor/stop
 *   GET  /api/transcription/config/validate
 */

import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  getTranscriptByRecordingId,
  getTranscriptsByRecordingIds,
  searchTranscripts,
  updateTranscriptTurns,
  getRecordingById,
  getQueueItems,
  updateQueueItem,
  updateRecordingTranscriptionStatus,
  addToQueue,
  isSummaryStale,
  getRecordingSpeakers,
  getContactById,
  clearTranscriptForRetranscribe,
  clearTranscriptStage2Marker,
  deleteRecordingSpeakersForRecording,
  deleteLabelEmbeddingsForRecording,
  deleteWindowEmbeddingsForRecording,
  expireSuggestionsForRecording,
  rependFailedItems,
  setTranscriptTemplateOverride,
  queryOne
} from '../../main/services/database'
import {
  toCsv,
  toSrt,
  toJson,
  sanitizeBasename,
  type ExportData
} from '../../main/services/transcript-export'
import {
  cancelTranscription,
  cancelAllTranscriptions,
  processQueueManually,
  startTranscriptionProcessor,
  stopTranscriptionProcessor,
  getTranscriptionStatus
} from '../../main/services/transcription'
import { validateTranscriptionConfig } from '../../main/services/transcription-config'
import { NotFoundError, BadRequestError } from './_errors'
import type { Turn } from '../../main/services/asr/asr-provider'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const byRecordingIdsBody = z.object({
  ids: z.array(z.string())
})

const searchQ = z.object({
  q: z.string().min(1)
})

const TurnSchema = z.object({
  speaker: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  text: z.string(),
  words: z
    .array(
      z.object({
        text: z.string(),
        startMs: z.number(),
        endMs: z.number()
      })
    )
    .optional(),
  sentiment: z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE']).optional()
})

const updateTurnsBody = z.object({
  turns: z.array(TurnSchema)
})

const exportQ = z.object({
  format: z.enum(['csv', 'srt', 'json'])
})

const resummarizeBody = z.object({
  templateId: z.string().min(1).nullable().optional()
})

const patchQueueBody = z.object({
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'cancelled', 'parked']),
  errorMessage: z.string().optional()
})

// ---------------------------------------------------------------------------
// Helper — build ExportData from the DB rows
// ---------------------------------------------------------------------------

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : []
  } catch {
    return []
  }
}

function parseTurns(raw: string | null | undefined): Turn[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as Turn[]) : null
  } catch {
    return null
  }
}

function stripExt(name: string): string {
  return name.replace(/\.[^./\\]+$/, '')
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function registerTranscripts(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------
  // GET /api/recordings/:id/transcript
  // ------------------------------------------------------------------
  app.get('/api/recordings/:id/transcript', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    const rec = getRecordingById(id)
    if (!rec) throw new NotFoundError('recording not found')
    const transcript = getTranscriptByRecordingId(id)
    if (!transcript) throw new NotFoundError('transcript not found')
    return transcript
  })

  // ------------------------------------------------------------------
  // POST /api/transcripts/by-recording-ids
  // ------------------------------------------------------------------
  app.post('/api/transcripts/by-recording-ids', { preHandler: [app.requireAuth] }, async (req) => {
    const { ids } = byRecordingIdsBody.parse(req.body)
    const map = getTranscriptsByRecordingIds(ids)
    return Object.fromEntries(map)
  })

  // ------------------------------------------------------------------
  // GET /api/transcripts/search?q=
  // ------------------------------------------------------------------
  app.get('/api/transcripts/search', { preHandler: [app.requireAuth] }, async (req) => {
    const q = searchQ.safeParse(req.query)
    if (!q.success) throw new BadRequestError('q query param required')
    return searchTranscripts(q.data.q)
  })

  // ------------------------------------------------------------------
  // PATCH /api/recordings/:id/transcript/turns
  // Body limit raised: long transcripts can be large.
  // ------------------------------------------------------------------
  app.patch(
    '/api/recordings/:id/transcript/turns',
    { preHandler: [app.requireAuth, app.requireSameOrigin], bodyLimit: 16 * 1024 * 1024 },
    async (req) => {
      const { id } = req.params as { id: string }
      const rec = getRecordingById(id)
      if (!rec) throw new NotFoundError('recording not found')
      const body = updateTurnsBody.parse(req.body)
      updateTranscriptTurns(id, body.turns as Turn[])
      deleteLabelEmbeddingsForRecording(id)
      deleteWindowEmbeddingsForRecording(id)
      return { ok: true, recordingId: id }
    }
  )

  // ------------------------------------------------------------------
  // POST /api/recordings/:id/transcript/export?format=csv|srt|json
  // Returns the file content as a browser download (no native dialog).
  // ------------------------------------------------------------------
  app.post(
    '/api/recordings/:id/transcript/export',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const q = exportQ.safeParse(req.query)
      if (!q.success) throw new BadRequestError('format query param required (csv|srt|json)')
      const { format } = q.data

      const transcript = getTranscriptByRecordingId(id)
      if (!transcript) throw new NotFoundError('transcript not found')

      const turns = parseTurns(transcript.turns)
      const isDiarized = Array.isArray(turns) && turns.length > 0
      if ((format === 'csv' || format === 'srt') && !isDiarized) {
        throw new BadRequestError('CSV and SRT export require diarization; re-transcribe with diarization first')
      }

      const recording = getRecordingById(id)
      const fileFallback = recording?.original_filename || recording?.filename
      const aiTitle = transcript.title_suggestion?.trim()
      const title = aiTitle || (fileFallback ? stripExt(fileFallback) : '') || 'transcript'
      const durationMs =
        recording && typeof recording.duration_seconds === 'number'
          ? Math.round(recording.duration_seconds * 1000)
          : null

      // Build speaker roster
      const speakers: Record<string, string> = {}
      for (const row of getRecordingSpeakers(id)) {
        if (!row.contact_id) continue
        const contact = getContactById(row.contact_id)
        if (contact) speakers[row.file_label] = contact.name
      }

      const data: ExportData = {
        recording: {
          id,
          title,
          dateRecorded: recording?.date_recorded ?? '',
          durationMs,
          language: transcript.language ?? '',
          transcriptionProvider: transcript.transcription_provider ?? null,
          transcriptionModel: transcript.transcription_model ?? null
        },
        fullText: transcript.full_text ?? '',
        turns,
        analysis: {
          summary: transcript.summary ?? null,
          actionItems: parseStringArray(transcript.action_items),
          topics: parseStringArray(transcript.topics),
          keyPoints: parseStringArray(transcript.key_points),
          titleSuggestion: transcript.title_suggestion ?? null,
          sentiment: transcript.sentiment ?? null
        },
        speakers
      }

      const content = format === 'csv' ? toCsv(data) : format === 'srt' ? toSrt(data) : toJson(data)
      const contentType =
        format === 'csv'
          ? 'text/csv; charset=utf-8'
          : format === 'srt'
            ? 'application/x-subrip; charset=utf-8'
            : 'application/json; charset=utf-8'
      const filename = `${sanitizeBasename(title)}.${format}`

      return reply
        .header('Content-Type', contentType)
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(content)
    }
  )

  // ------------------------------------------------------------------
  // POST /api/recordings/:id/transcribe
  // ------------------------------------------------------------------
  app.post(
    '/api/recordings/:id/transcribe',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id } = req.params as { id: string }
      const rec = getRecordingById(id)
      if (!rec) throw new NotFoundError('recording not found')

      // Re-transcribe: clear prior transcript and speaker state (mirrors IPC handler).
      const existingTranscript = getTranscriptByRecordingId(id)
      if (existingTranscript?.full_text) {
        clearTranscriptForRetranscribe(id)
        deleteRecordingSpeakersForRecording(id)
        deleteLabelEmbeddingsForRecording(id)
        deleteWindowEmbeddingsForRecording(id)
        expireSuggestionsForRecording(id)
      }

      // Preflight: reject when no provider key is configured (mirrors recordings:addToQueue).
      const configCheck = validateTranscriptionConfig()
      if (!configCheck.ok) {
        throw new BadRequestError('Transcription API key not configured. Please add your API key in Settings.')
      }

      const queueItemId = addToQueue(id)
      // Mirror recordings:addToQueue: update recording row immediately so polling clients see 'queued'.
      updateRecordingTranscriptionStatus(id, 'queued')
      // Fire-and-forget — do NOT await (returns 200 immediately)
      processQueueManually().catch((err: unknown) => {
        console.error('[transcribe] processQueueManually error:', err)
      })
      return { queueItemId }
    }
  )

  // ------------------------------------------------------------------
  // POST /api/recordings/:id/resummarize
  // ------------------------------------------------------------------
  app.post(
    '/api/recordings/:id/resummarize',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id } = req.params as { id: string }
      const rec = getRecordingById(id)
      if (!rec) throw new NotFoundError('recording not found')

      const body = resummarizeBody.parse(req.body)
      const existingTranscript = getTranscriptByRecordingId(id)
      if (!existingTranscript?.full_text?.trim()) {
        throw new BadRequestError('no transcript to summarize yet — transcribe this recording first')
      }

      setTranscriptTemplateOverride(id, body.templateId ?? null)
      clearTranscriptStage2Marker(id)
      addToQueue(id)
      // Fire-and-forget
      processQueueManually().catch((err: unknown) => {
        console.error('[resummarize] processQueueManually error:', err)
      })
      return { ok: true }
    }
  )

  // ------------------------------------------------------------------
  // GET /api/recordings/:id/summary-stale
  // ------------------------------------------------------------------
  app.get('/api/recordings/:id/summary-stale', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    const rec = getRecordingById(id)
    if (!rec) throw new NotFoundError('recording not found')
    return { stale: isSummaryStale(id) }
  })

  // ------------------------------------------------------------------
  // POST /api/recordings/:id/transcription/cancel
  // ------------------------------------------------------------------
  app.post(
    '/api/recordings/:id/transcription/cancel',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id } = req.params as { id: string }
      cancelTranscription(id)
      return { ok: true }
    }
  )

  // ------------------------------------------------------------------
  // POST /api/recordings/:id/transcription/retry
  // ------------------------------------------------------------------
  app.post(
    '/api/recordings/:id/transcription/retry',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id } = req.params as { id: string }
      const rec = getRecordingById(id)
      if (!rec) throw new NotFoundError('recording not found')
      addToQueue(id)
      // Mirror transcription:retry IPC handler: update recording row immediately so
      // polling clients see 'pending' rather than the prior stale status.
      updateRecordingTranscriptionStatus(id, 'pending')
      processQueueManually().catch((err: unknown) => {
        console.error('[transcription/retry] processQueueManually error:', err)
      })
      return { ok: true }
    }
  )

  // ------------------------------------------------------------------
  // GET /api/queue?status=
  // ------------------------------------------------------------------
  app.get('/api/queue', { preHandler: [app.requireAuth] }, async (req) => {
    const q = req.query as Record<string, string>
    return getQueueItems(q.status)
  })

  // ------------------------------------------------------------------
  // PATCH /api/queue/:id
  // ------------------------------------------------------------------
  app.patch(
    '/api/queue/:id',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id } = req.params as { id: string }
      const existing = queryOne<{ id: string }>('SELECT id FROM transcription_queue WHERE id = ?', [id])
      if (!existing) throw new NotFoundError('queue item not found')
      const body = patchQueueBody.parse(req.body)
      updateQueueItem(id, body.status, body.errorMessage)
      return { ok: true }
    }
  )

  // ------------------------------------------------------------------
  // POST /api/queue/process  — must be before /api/queue/:id
  // ------------------------------------------------------------------
  app.post('/api/queue/process', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async () => {
    processQueueManually().catch((err: unknown) => {
      console.error('[queue/process] processQueueManually error:', err)
    })
    return { ok: true }
  })

  // ------------------------------------------------------------------
  // POST /api/queue/cancel-all
  // ------------------------------------------------------------------
  app.post('/api/queue/cancel-all', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async () => {
    const count = cancelAllTranscriptions()
    return { ok: true, count }
  })

  // ------------------------------------------------------------------
  // POST /api/queue/retry-failed
  // ------------------------------------------------------------------
  app.post('/api/queue/retry-failed', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async () => {
    const count = rependFailedItems(['OpenAI', 'Ollama Cloud', 'Gemini API key', 'AssemblyAI'])
    if (count > 0) {
      processQueueManually().catch((err: unknown) => {
        console.error('[queue/retry-failed] processQueueManually error:', err)
      })
    }
    return { ok: true, count }
  })

  // ------------------------------------------------------------------
  // GET /api/queue/status  — must be before /api/queue/:id
  // ------------------------------------------------------------------
  app.get('/api/queue/status', { preHandler: [app.requireAuth] }, async () => {
    return getTranscriptionStatus()
  })

  // ------------------------------------------------------------------
  // POST /api/queue/processor/start
  // ------------------------------------------------------------------
  app.post('/api/queue/processor/start', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async () => {
    startTranscriptionProcessor()
    return { ok: true }
  })

  // ------------------------------------------------------------------
  // POST /api/queue/processor/stop
  // ------------------------------------------------------------------
  app.post('/api/queue/processor/stop', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async () => {
    stopTranscriptionProcessor()
    return { ok: true }
  })

  // ------------------------------------------------------------------
  // GET /api/transcription/config/validate
  // ------------------------------------------------------------------
  app.get('/api/transcription/config/validate', { preHandler: [app.requireAuth] }, async () => {
    return validateTranscriptionConfig()
  })
}
