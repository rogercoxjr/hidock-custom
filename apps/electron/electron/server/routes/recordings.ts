import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  getRecordings,
  getRecordingById,
  getTranscriptByRecordingId
} from '../../main/services/database'
import { NotFoundError } from './_errors'

const listQ = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.string().optional(),
  quality: z.string().optional()
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

  app.get('/api/recordings/:id', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    const rec = getRecordingById(id)
    if (!rec) throw new NotFoundError('recording not found')
    return rec
  })
}
