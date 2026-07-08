import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { queryAll, queryOne, run } from '../../main/services/database'
import { NotFoundError, BadRequestError } from './_errors'

// B-CHAT-007: Explicit column list instead of SELECT *
const KNOWLEDGE_CAPTURE_COLUMNS = `id, title, summary, category, status, quality_rating, quality_confidence, quality_assessed_at, storage_tier, retention_days, expires_at, meeting_id, correlation_confidence, correlation_method, source_recording_id, captured_at, created_at, updated_at, deleted_at`

function mapRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    category: row.category,
    status: row.status,
    quality: row.quality_rating,
    qualityConfidence: row.quality_confidence,
    qualityAssessedAt: row.quality_assessed_at,
    storageTier: row.storage_tier,
    retentionDays: row.retention_days,
    expiresAt: row.expires_at,
    meetingId: row.meeting_id,
    correlationConfidence: row.correlation_confidence,
    correlationMethod: row.correlation_method,
    sourceRecordingId: row.source_recording_id,
    capturedAt: row.captured_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  }
}

const listQ = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.string().optional(),
  quality: z.string().optional(),
  category: z.string().optional()
})

const byIdsBody = z.object({
  ids: z.array(z.string()).min(1)
})

const patchBody = z.object({
  title: z.string().optional(),
  summary: z.string().optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  quality: z.string().optional(),
  storageTier: z.string().optional()
})

export async function registerKnowledge(app: FastifyInstance): Promise<void> {
  // GET /api/knowledge — paginated list with optional filters
  app.get('/api/knowledge', { preHandler: [app.requireAuth] }, async (req) => {
    const q = listQ.parse(req.query)

    let sql = `SELECT ${KNOWLEDGE_CAPTURE_COLUMNS} FROM knowledge_captures`
    const conditions: string[] = ['deleted_at IS NULL']
    const params: (string | number)[] = []

    if (q.status) {
      conditions.push('status = ?')
      params.push(q.status)
    }
    if (q.quality) {
      conditions.push('quality_rating = ?')
      params.push(q.quality)
    }
    if (q.category) {
      conditions.push('category = ?')
      params.push(q.category)
    }

    sql += ` WHERE ${conditions.join(' AND ')}`

    // Count total before pagination
    const countSql = `SELECT COUNT(*) as total FROM knowledge_captures WHERE ${conditions.join(' AND ')}`
    const countRow = queryOne<{ total: number }>(countSql, params)
    const total = countRow?.total ?? 0

    sql += ` ORDER BY captured_at DESC LIMIT ? OFFSET ?`
    params.push(q.limit, q.offset)

    const rows = queryAll<Record<string, unknown>>(sql, params)
    return { items: rows.map(mapRow), total }
  })

  // Must be registered before /:id to avoid route conflict
  // POST /api/knowledge/by-ids — batch fetch
  app.post('/api/knowledge/by-ids', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { ids } = byIdsBody.parse(req.body)
    const placeholders = ids.map(() => '?').join(',')
    const rows = queryAll<Record<string, unknown>>(
      `SELECT ${KNOWLEDGE_CAPTURE_COLUMNS} FROM knowledge_captures WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
      ids
    )
    return rows.map(mapRow)
  })

  // GET /api/knowledge/:id
  app.get('/api/knowledge/:id', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    const row = queryOne<Record<string, unknown>>(
      `SELECT ${KNOWLEDGE_CAPTURE_COLUMNS} FROM knowledge_captures WHERE id = ? AND deleted_at IS NULL`,
      [id]
    )
    if (!row) throw new NotFoundError('knowledge capture not found')
    return mapRow(row)
  })

  // PATCH /api/knowledge/:id — partial update
  app.patch('/api/knowledge/:id', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { id } = req.params as { id: string }

    const existing = queryOne<Record<string, unknown>>(
      `SELECT ${KNOWLEDGE_CAPTURE_COLUMNS} FROM knowledge_captures WHERE id = ?`,
      [id]
    )
    if (!existing) throw new NotFoundError('knowledge capture not found')

    const body = patchBody.parse(req.body)

    const fields: string[] = []
    const values: (string | number)[] = []

    if (body.title !== undefined) { fields.push('title = ?'); values.push(body.title) }
    if (body.summary !== undefined) { fields.push('summary = ?'); values.push(body.summary) }
    if (body.category !== undefined) { fields.push('category = ?'); values.push(body.category) }
    if (body.status !== undefined) { fields.push('status = ?'); values.push(body.status) }
    if (body.quality !== undefined) { fields.push('quality_rating = ?'); values.push(body.quality) }
    if (body.storageTier !== undefined) { fields.push('storage_tier = ?'); values.push(body.storageTier) }

    if (fields.length === 0) throw new BadRequestError('no updatable fields provided')

    fields.push('updated_at = CURRENT_TIMESTAMP')
    run(`UPDATE knowledge_captures SET ${fields.join(', ')} WHERE id = ?`, [...values, id])

    const updated = queryOne<Record<string, unknown>>(
      `SELECT ${KNOWLEDGE_CAPTURE_COLUMNS} FROM knowledge_captures WHERE id = ?`,
      [id]
    )
    return mapRow(updated!)
  })
}
