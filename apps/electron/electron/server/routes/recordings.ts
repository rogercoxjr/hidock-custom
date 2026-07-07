import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { basename, extname } from 'path'
import { statSync, existsSync } from 'fs'
import {
  getRecordings,
  getRecordingById,
  getRecordingsByQuality,
  getTranscriptByRecordingId,
  updateRecordingStatus,
  updateRecordingTranscriptionStatus,
  linkRecordingToMeeting,
  deleteLabelEmbeddingsForRecording,
  deleteWindowEmbeddingsForRecording,
  getCandidatesForRecordingWithDetails,
  getMeetingsNearDate,
  insertRecording,
  addToQueue
} from '../../main/services/database'
import { deleteRecording as deleteRecordingFile, saveRecording } from '../../main/services/file-storage'
import { NotFoundError, BadRequestError } from './_errors'

const ALLOWED_AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.webm', '.hda'])

const listQ = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.string().optional(),
  quality: z.enum(['high', 'medium', 'low']).optional()
})

const patchBody = z.object({
  status: z.string().optional(),
  transcriptionStatus: z.string().optional()
})

const linkMeetingBody = z.object({
  meetingId: z.string(),
  confidence: z.number().optional(),
  method: z.string().optional()
})

const selectMeetingBody = z.object({
  meetingId: z.string().nullable()
})

const batchDeleteBody = z.object({
  ids: z.array(z.string())
})

const nearDateQ = z.object({
  date: z.string()
})

export async function registerRecordings(app: FastifyInstance): Promise<void> {
  app.get('/api/recordings', { preHandler: [app.requireAuth] }, async (req) => {
    const q = listQ.parse(req.query)
    // quality filtering joins recordings to quality_assessments (0c-4 quality domain);
    // getRecordingsByQuality() already does this join, so use it as the base set when requested.
    let rows = q.quality ? getRecordingsByQuality(q.quality) : getRecordings()
    if (q.status) rows = rows.filter((r) => r.status === q.status)
    return { items: rows.slice(q.offset, q.offset + q.limit), total: rows.length }
  })

  app.get('/api/recordings/with-transcripts', { preHandler: [app.requireAuth] }, async (req) => {
    const q = listQ.parse(req.query)
    const rows = getRecordings()
    const page = rows.slice(q.offset, q.offset + q.limit)
    return {
      items: page.map((r) => ({ ...r, transcript: getTranscriptByRecordingId(r.id) ?? null })),
      total: rows.length
    }
  })

  // Must be registered before /:id to avoid route conflict
  app.get('/api/recordings/meetings-near-date', { preHandler: [app.requireAuth] }, async (req) => {
    const q = nearDateQ.safeParse(req.query)
    if (!q.success) throw new BadRequestError('date query param required')
    return getMeetingsNearDate(q.data.date)
  })

  // Batch delete — register before /:id/... to avoid ambiguity
  app.post('/api/recordings/batch-delete', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { ids } = batchDeleteBody.parse(req.body)
    let deleted = 0
    let failed = 0
    const errors: Array<{ id: string; error: string }> = []

    for (const id of ids) {
      try {
        const rec = getRecordingById(id)
        if (!rec) {
          failed++
          errors.push({ id, error: 'recording not found' })
          continue
        }
        if (rec.file_path) {
          deleteRecordingFile(rec.file_path)
        }
        updateRecordingStatus(id, 'deleted')
        deleteLabelEmbeddingsForRecording(id)
        deleteWindowEmbeddingsForRecording(id)
        deleted++
      } catch (e) {
        failed++
        errors.push({ id, error: e instanceof Error ? e.message : 'unknown error' })
      }
    }

    return { deleted, failed, errors }
  })

  app.get('/api/recordings/:id', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    const rec = getRecordingById(id)
    if (!rec) throw new NotFoundError('recording not found')
    return rec
  })

  app.patch('/api/recordings/:id', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { id } = req.params as { id: string }
    const rec = getRecordingById(id)
    if (!rec) throw new NotFoundError('recording not found')
    const body = patchBody.parse(req.body)
    if (body.status !== undefined) updateRecordingStatus(id, body.status)
    if (body.transcriptionStatus !== undefined) updateRecordingTranscriptionStatus(id, body.transcriptionStatus)
    return getRecordingById(id)
  })

  app.delete('/api/recordings/:id', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { id } = req.params as { id: string }
    const rec = getRecordingById(id)
    if (!rec) throw new NotFoundError('recording not found')
    if (rec.file_path) {
      deleteRecordingFile(rec.file_path)
    }
    updateRecordingStatus(id, 'deleted')
    deleteLabelEmbeddingsForRecording(id)
    deleteWindowEmbeddingsForRecording(id)
    return { ok: true }
  })

  app.post('/api/recordings/:id/link-meeting', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { id } = req.params as { id: string }
    const rec = getRecordingById(id)
    if (!rec) throw new NotFoundError('recording not found')
    const body = linkMeetingBody.parse(req.body)
    linkRecordingToMeeting(id, body.meetingId, body.confidence ?? 1.0, body.method ?? 'manual')
    return getRecordingById(id)
  })

  app.post('/api/recordings/:id/unlink-meeting', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { id } = req.params as { id: string }
    const rec = getRecordingById(id)
    if (!rec) throw new NotFoundError('recording not found')
    linkRecordingToMeeting(id, '', 0, '')
    return getRecordingById(id)
  })

  app.post('/api/recordings/:id/select-meeting', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { id } = req.params as { id: string }
    const rec = getRecordingById(id)
    if (!rec) throw new NotFoundError('recording not found')
    const body = selectMeetingBody.parse(req.body)
    if (body.meetingId === null) {
      linkRecordingToMeeting(id, '', 0, '')
    } else {
      linkRecordingToMeeting(id, body.meetingId, 1.0, 'manual')
    }
    return getRecordingById(id)
  })

  app.get('/api/recordings/:id/candidates', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    const rec = getRecordingById(id)
    if (!rec) throw new NotFoundError('recording not found')
    return getCandidatesForRecordingWithDetails(id)
  })

  app.post(
    '/api/recordings/upload',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req, reply) => {
      // Consume the multipart upload — one file field named "file"
      const data = await req.file()
      if (!data) throw new BadRequestError('no file uploaded')

      const originalFilename = basename(data.filename)
      const ext = extname(originalFilename).toLowerCase()
      if (!ALLOWED_AUDIO_EXTENSIONS.has(ext)) {
        // Drain the stream to avoid connection stall
        data.file.resume()
        throw new BadRequestError(
          `unsupported file type: ${ext}. Allowed: ${[...ALLOWED_AUDIO_EXTENSIONS].join(', ')}`
        )
      }

      // Read file bytes into a Buffer
      const chunks: Buffer[] = []
      for await (const chunk of data.file) {
        chunks.push(chunk)
      }
      const buffer = Buffer.concat(chunks)

      // Persist to recordings directory (handles .hda→.wav + collision resolution)
      const storedPath = await saveRecording(originalFilename, buffer)

      // Derive file size from the stored file (most accurate after any processing)
      let fileSize: number | undefined
      try {
        if (existsSync(storedPath)) {
          fileSize = statSync(storedPath).size
        }
      } catch {
        fileSize = buffer.length
      }

      // Determine actual stored filename
      const storedFilename = basename(storedPath)

      // Insert the recording row, mirroring addExternal defaults
      const id = randomUUID()
      insertRecording({
        id,
        filename: storedFilename,
        original_filename: originalFilename,
        file_path: storedPath,
        file_size: fileSize,
        duration_seconds: undefined,
        date_recorded: new Date().toISOString(),
        meeting_id: undefined,
        correlation_confidence: undefined,
        correlation_method: undefined,
        status: 'ready',
        location: 'local-only',
        transcription_status: 'none',
        on_device: 0,
        device_last_seen: undefined,
        on_local: 1,
        source: 'upload',
        is_imported: 1
      })

      // Optional: enqueue for transcription (fire-and-forget)
      const enqueueParam = (req.query as Record<string, string>)['enqueue']
      if (enqueueParam === '1') {
        addToQueue(id)
        // Fire-and-forget — do NOT await (returns 201 immediately)
        import('../../main/services/transcription')
          .then(({ processQueueManually }) => {
            processQueueManually().catch((err: unknown) => {
              console.error('[upload] processQueueManually error:', err)
            })
          })
          .catch((err: unknown) => {
            console.error('[upload] Failed to import transcription service:', err)
          })
      }

      const recording = getRecordingById(id)
      return reply.code(201).send({ recording })
    }
  )

}
