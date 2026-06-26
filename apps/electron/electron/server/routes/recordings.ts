import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  getRecordings,
  getRecordingById,
  getTranscriptByRecordingId,
  updateRecordingStatus,
  updateRecordingTranscriptionStatus,
  linkRecordingToMeeting,
  deleteLabelEmbeddingsForRecording,
  deleteWindowEmbeddingsForRecording,
  getCandidatesForRecordingWithDetails,
  getMeetingsNearDate
} from '../../main/services/database'
import { deleteRecording as deleteRecordingFile } from '../../main/services/file-storage'
import { NotFoundError, BadRequestError } from './_errors'

const listQ = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.string().optional(),
  quality: z.string().optional()
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
    let rows = getRecordings()
    if (q.status) rows = rows.filter((r) => r.status === q.status)
    if (q.quality) rows = rows.filter((r) => (r as { quality_rating?: string }).quality_rating === q.quality)
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
}
