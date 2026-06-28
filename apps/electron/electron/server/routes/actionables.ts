import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { queryAll, run } from '../../main/services/database'
import { NotFoundError, BadRequestError } from './_errors'

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

const listQ = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0)
})

const VALID_STATUSES = ['pending', 'in_progress', 'generated', 'shared', 'dismissed'] as const

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

    let sql = 'SELECT * FROM actionables'
    const params: unknown[] = []

    if (q.status) {
      sql += ' WHERE status = ?'
      params.push(q.status)
    }

    sql += ' ORDER BY created_at DESC'

    const rows = queryAll<Record<string, unknown>>(sql, params)
    const all = rows.map(mapRow)
    return { items: all.slice(q.offset, q.offset + q.limit), total: all.length }
  })

  // GET /api/meetings/:id/actionables
  app.get('/api/meetings/:id/actionables', { preHandler: [app.requireAuth] }, async (req) => {
    const { id: meetingId } = req.params as { id: string }

    const sql = `
      SELECT DISTINCT a.*
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

    const existing = queryAll<Record<string, unknown>>('SELECT * FROM actionables WHERE id = ?', [id])[0]
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

    const updated = queryAll<Record<string, unknown>>('SELECT * FROM actionables WHERE id = ?', [id])[0]
    return mapRow(updated)
  })

  // POST /api/actionables/:id/generate-output
  app.post(
    '/api/actionables/:id/generate-output',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id } = req.params as { id: string }

      const actionable = queryAll<Record<string, unknown>>('SELECT * FROM actionables WHERE id = ?', [id])[0]
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
