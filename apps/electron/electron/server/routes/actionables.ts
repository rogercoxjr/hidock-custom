import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { queryAll, queryOne, run } from '../../main/services/database'
import { NotFoundError, BadRequestError } from './_errors'

// ---------------------------------------------------------------------------
// Explicit column list used in every SELECT to match mapRow's keys
// (prevents silent breakage when new columns are added, mirrors B-CHAT-007)
// ---------------------------------------------------------------------------
const ACTIONABLE_COLUMNS =
  'id, type, title, description, source_knowledge_id, source_action_item_id, ' +
  'suggested_template, suggested_recipients, status, confidence, artifact_id, ' +
  'generated_at, shared_at, created_at, updated_at'

// ---------------------------------------------------------------------------
// Shared row→camelCase mapper (mirrors the IPC handler's mapToActionable)
// ---------------------------------------------------------------------------

function mapRow(row: Record<string, unknown>) {
  let suggestedRecipients: string[] = []
  if (row.suggested_recipients) {
    try {
      suggestedRecipients = JSON.parse(row.suggested_recipients as string)
    } catch {
      suggestedRecipients = []
    }
  }

  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description ?? null,
    sourceKnowledgeId: row.source_knowledge_id,
    sourceActionItemId: row.source_action_item_id ?? null,
    suggestedTemplate: row.suggested_template ?? null,
    suggestedRecipients,
    status: row.status,
    confidence: row.confidence ?? null,
    artifactId: row.artifact_id ?? null,
    generatedAt: row.generated_at ?? null,
    sharedAt: row.shared_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const VALID_STATUSES = ['pending', 'in_progress', 'generated', 'shared', 'dismissed'] as const

const listQ = z.object({
  // Restrict to known enum values so unknown strings return 400 instead of a
  // vacuous 200 empty list (e.g. ?status=DROP TABLE would silently 200 otherwise).
  status: z.enum(VALID_STATUSES).optional(),
  limit: z.coerce.number().int().positive().max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0)
})

const validTransitions: Record<string, string[]> = {
  pending: ['in_progress', 'generated', 'dismissed'],
  in_progress: ['generated', 'pending'],
  generated: ['shared', 'pending', 'dismissed'],
  shared: ['pending'],
  dismissed: ['pending']
}

const patchBody = z.object({
  status: z.enum(VALID_STATUSES)
})

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function registerActionables(app: FastifyInstance): Promise<void> {
  // GET /api/actionables?status=&limit=&offset=
  app.get('/api/actionables', { preHandler: [app.requireAuth] }, async (req) => {
    const q = listQ.parse(req.query)

    // Use SQL-level COUNT + LIMIT/OFFSET instead of fetching all rows into JS
    // memory and slicing (mirrors the best practice from B-CHAT-007).
    let countSql = 'SELECT COUNT(*) AS cnt FROM actionables'
    let dataSql = `SELECT ${ACTIONABLE_COLUMNS} FROM actionables`
    const countParams: unknown[] = []
    const dataParams: unknown[] = []

    if (q.status) {
      countSql += ' WHERE status = ?'
      dataSql += ' WHERE status = ?'
      countParams.push(q.status)
      dataParams.push(q.status)
    }

    dataSql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
    dataParams.push(q.limit, q.offset)

    const totalRow = queryOne<{ cnt: number }>(countSql, countParams)
    const total = totalRow?.cnt ?? 0
    const rows = queryAll<Record<string, unknown>>(dataSql, dataParams)
    return { items: rows.map(mapRow), total }
  })

  // GET /api/meetings/:id/actionables
  app.get('/api/meetings/:id/actionables', { preHandler: [app.requireAuth] }, async (req) => {
    const { id: meetingId } = req.params as { id: string }

    const sql = `
      SELECT DISTINCT ${ACTIONABLE_COLUMNS.split(', ').map((c) => `a.${c}`).join(', ')}
      FROM actionables a
      INNER JOIN knowledge_captures kc ON a.source_knowledge_id = kc.id
      LEFT JOIN recordings r ON kc.source_recording_id = r.id
      WHERE kc.meeting_id = ?
         OR r.meeting_id = ?
      ORDER BY a.created_at DESC
    `
    const rows = queryAll<Record<string, unknown>>(sql, [meetingId, meetingId])
    return rows.map(mapRow)
  })

  // PATCH /api/actionables/:id  { status }
  app.patch('/api/actionables/:id', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { id } = req.params as { id: string }

    const existing = queryOne<Record<string, unknown>>(
      `SELECT ${ACTIONABLE_COLUMNS} FROM actionables WHERE id = ?`,
      [id]
    )
    if (!existing) throw new NotFoundError('actionable not found')

    const body = patchBody.parse(req.body)
    const newStatus = body.status

    const allowed = validTransitions[existing.status as string] ?? []
    if (!allowed.includes(newStatus)) {
      throw new BadRequestError(
        `invalid status transition: ${existing.status as string} → ${newStatus}`
      )
    }

    // C-ACT-002: clean up output artifact when reverting away from 'generated'
    if ((newStatus === 'dismissed' || newStatus === 'pending') && existing.artifact_id) {
      try {
        run('DELETE FROM outputs WHERE id = ?', [existing.artifact_id])
        run('UPDATE actionables SET artifact_id = NULL, generated_at = NULL WHERE id = ?', [id])
      } catch {
        // continue even if cleanup fails — mirrors the IPC handler behaviour
      }
    }

    run('UPDATE actionables SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newStatus, id])

    const updated = queryOne<Record<string, unknown>>(
      `SELECT ${ACTIONABLE_COLUMNS} FROM actionables WHERE id = ?`,
      [id]
    )
    return mapRow(updated!)
  })

  // POST /api/actionables/:id/generate-output
  app.post(
    '/api/actionables/:id/generate-output',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id } = req.params as { id: string }

      const actionable = queryOne<Record<string, unknown>>(
        `SELECT ${ACTIONABLE_COLUMNS} FROM actionables WHERE id = ?`,
        [id]
      )
      if (!actionable) throw new NotFoundError('actionable not found')

      const status = actionable.status as string
      if (status !== 'pending' && status !== 'generated') {
        throw new BadRequestError(
          `cannot generate from '${status}' status. Must be 'pending' or 'generated'.`
        )
      }

      run(
        'UPDATE actionables SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['in_progress', id]
      )

      return {
        actionableId: id,
        sourceKnowledgeId: actionable.source_knowledge_id,
        suggestedTemplate: actionable.suggested_template ?? null
      }
    }
  )
}
