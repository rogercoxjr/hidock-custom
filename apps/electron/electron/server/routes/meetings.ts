import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  getMeetings,
  getMeetingById,
  getMeetingsByIds,
  updateMeeting,
  getRecordingsForMeeting,
  getTranscriptByRecordingId
} from '../../main/services/database'
import { NotFoundError } from './_errors'

// ─── Validation schemas ────────────────────────────────────────────────────────

const listQ = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional()
})

const byIdsBody = z.object({
  ids: z.array(z.string()).min(1)
})

const patchBody = z
  .object({
    subject: z.string().min(1).max(1000).optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    location: z.string().nullable().optional(),
    description: z.string().nullable().optional()
  })
  .refine(
    (d) =>
      d.subject !== undefined ||
      d.start_time !== undefined ||
      d.end_time !== undefined ||
      d.location !== undefined ||
      d.description !== undefined,
    { message: 'at least one field must be provided' }
  )

// ─── Route registration ────────────────────────────────────────────────────────

export async function registerMeetings(app: FastifyInstance): Promise<void> {
  // GET /api/meetings?startDate=&endDate=
  app.get('/api/meetings', { preHandler: [app.requireAuth] }, async (req) => {
    const q = listQ.parse(req.query)
    return getMeetings(q.startDate, q.endDate)
  })

  // POST /api/meetings/by-ids  { ids: string[] }
  // Must be registered before /:id to avoid route conflict
  app.post('/api/meetings/by-ids', { preHandler: [app.requireAuth] }, async (req) => {
    const { ids } = byIdsBody.parse(req.body)
    const map = getMeetingsByIds(ids)
    // Return as plain object (Map → object for JSON serialization, same as db-handlers)
    return Object.fromEntries(map)
  })

  // GET /api/meetings/:id
  app.get('/api/meetings/:id', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    const meeting = getMeetingById(id)
    if (!meeting) throw new NotFoundError('meeting not found')
    return meeting
  })

  // GET /api/meetings/:id/details — meeting + recordings with transcripts
  app.get('/api/meetings/:id/details', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    const meeting = getMeetingById(id)
    if (!meeting) throw new NotFoundError('meeting not found')

    const recordings = getRecordingsForMeeting(id)
    const recordingsWithTranscripts = recordings.map((recording) => ({
      ...recording,
      transcript: getTranscriptByRecordingId(recording.id) ?? null
    }))

    return { meeting, recordings: recordingsWithTranscripts }
  })

  // PATCH /api/meetings/:id
  app.patch('/api/meetings/:id', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { id } = req.params as { id: string }
    const meeting = getMeetingById(id)
    if (!meeting) throw new NotFoundError('meeting not found')

    const body = patchBody.parse(req.body)

    // Build updates — strip undefined; preserve explicit null (clears nullable fields)
    const updates: Parameters<typeof updateMeeting>[1] = {}
    if (body.subject !== undefined) updates.subject = body.subject
    if (body.start_time !== undefined) updates.start_time = body.start_time
    if (body.end_time !== undefined) updates.end_time = body.end_time
    if (body.location !== undefined) updates.location = body.location ?? undefined
    if (body.description !== undefined) updates.description = body.description ?? undefined

    updateMeeting(id, updates)
    return getMeetingById(id)
  })

  // GET /api/meetings/:id/recordings
  // (also satisfies recordings:getForMeeting / db:get-recordings-for-meeting)
  app.get('/api/meetings/:id/recordings', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    const meeting = getMeetingById(id)
    if (!meeting) throw new NotFoundError('meeting not found')
    return getRecordingsForMeeting(id)
  })

}
