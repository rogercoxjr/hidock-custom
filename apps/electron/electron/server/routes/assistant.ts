import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { queryAll, queryOne, run, runNoSave, runInTransaction } from '../../main/services/database'
import { NotFoundError } from './_errors'

// B-CHAT-007: Explicit column lists instead of SELECT *
const CONVERSATION_COLUMNS = 'id, title, created_at, updated_at'
const MESSAGE_COLUMNS =
  'id, conversation_id, role, content, sources, created_at, edited_at, original_content, created_output_id, saved_as_insight_id'

const listConvQ = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0)
})

const createConvBody = z.object({
  title: z.string().optional()
})

const patchConvBody = z.object({
  title: z.string()
})

const addMessageBody = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  sources: z.string().optional()
})

const addContextBody = z.object({
  knowledgeCaptureId: z.string()
})

const removeContextBody = z.object({
  knowledgeCaptureId: z.string()
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapToConversation(row: any) {
  return {
    id: row.id as string,
    title: row.title as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapToMessage(row: any) {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    role: row.role as 'user' | 'assistant',
    content: row.content as string,
    sources: (row.sources as string | null) ?? null,
    createdAt: row.created_at as string,
    editedAt: (row.edited_at as string | null) ?? null,
    originalContent: (row.original_content as string | null) ?? null,
    createdOutputId: (row.created_output_id as string | null) ?? null,
    savedAsInsightId: (row.saved_as_insight_id as string | null) ?? null
  }
}

export async function registerAssistant(app: FastifyInstance): Promise<void> {
  // --- Conversations ---

  // GET /api/assistant/conversations  — paginated list
  app.get('/api/assistant/conversations', { preHandler: [app.requireAuth] }, async (req) => {
    const q = listConvQ.parse(req.query)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalRow = queryOne<any>('SELECT COUNT(*) AS cnt FROM conversations')
    const total = (totalRow?.cnt as number) ?? 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = queryAll<any>(
      `SELECT ${CONVERSATION_COLUMNS} FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [q.limit, q.offset]
    )
    return {
      items: rows.map(mapToConversation),
      total
    }
  })

  // POST /api/assistant/conversations  — create conversation
  app.post(
    '/api/assistant/conversations',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req, reply) => {
      const body = createConvBody.parse(req.body)
      const id = randomUUID()
      const now = new Date().toISOString()
      run('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', [
        id,
        body.title ?? 'New Conversation',
        now,
        now
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const conv = queryOne<any>(`SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = ?`, [id])
      return reply.code(201).send(mapToConversation(conv))
    }
  )

  // GET /api/assistant/conversations/:id  — get single conversation
  app.get('/api/assistant/conversations/:id', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conv = queryOne<any>(`SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = ?`, [id])
    if (!conv) throw new NotFoundError('conversation not found')
    return mapToConversation(conv)
  })

  // PATCH /api/assistant/conversations/:id  — update title
  app.patch(
    '/api/assistant/conversations/:id',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id } = req.params as { id: string }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing = queryOne<any>('SELECT id FROM conversations WHERE id = ?', [id])
      if (!existing) throw new NotFoundError('conversation not found')
      const body = patchConvBody.parse(req.body)
      run('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?', [
        body.title,
        new Date().toISOString(),
        id
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return mapToConversation(queryOne<any>(`SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = ?`, [id])!)
    }
  )

  // DELETE /api/assistant/conversations/:id  — delete conversation (cascades to messages + context)
  app.delete(
    '/api/assistant/conversations/:id',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id } = req.params as { id: string }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing = queryOne<any>('SELECT id FROM conversations WHERE id = ?', [id])
      if (!existing) throw new NotFoundError('conversation not found')
      run('DELETE FROM conversations WHERE id = ?', [id])
      return { ok: true }
    }
  )

  // --- Messages ---

  // GET /api/assistant/conversations/:id/messages  — list messages for a conversation
  app.get('/api/assistant/conversations/:id/messages', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conv = queryOne<any>('SELECT id FROM conversations WHERE id = ?', [id])
    if (!conv) throw new NotFoundError('conversation not found')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = queryAll<any>(
      `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC`,
      [id]
    )
    return rows.map(mapToMessage)
  })

  // POST /api/assistant/conversations/:id/messages  — add a message
  app.post(
    '/api/assistant/conversations/:id/messages',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const conv = queryOne<any>('SELECT id FROM conversations WHERE id = ?', [id])
      if (!conv) throw new NotFoundError('conversation not found')
      const body = addMessageBody.parse(req.body)
      const msgId = randomUUID()
      const now = new Date().toISOString()
      runInTransaction(() => {
        runNoSave(
          'INSERT INTO chat_messages (id, conversation_id, role, content, sources, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [msgId, id, body.role, body.content, body.sources ?? null, now]
        )
        runNoSave('UPDATE conversations SET updated_at = ? WHERE id = ?', [now, id])
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = queryOne<any>(`SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE id = ?`, [msgId])
      return reply.code(201).send(mapToMessage(msg!))
    }
  )

  // --- Context ---

  // GET /api/assistant/conversations/:id/context  — get knowledge-capture IDs attached as context
  app.get('/api/assistant/conversations/:id/context', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conv = queryOne<any>('SELECT id FROM conversations WHERE id = ?', [id])
    if (!conv) throw new NotFoundError('conversation not found')
    const rows = queryAll<{ knowledge_capture_id: string }>(
      'SELECT knowledge_capture_id FROM conversation_context WHERE conversation_id = ?',
      [id]
    )
    return rows.map((r) => r.knowledge_capture_id)
  })

  // POST /api/assistant/conversations/:id/context  — add a knowledge capture to context
  app.post(
    '/api/assistant/conversations/:id/context',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id } = req.params as { id: string }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const conv = queryOne<any>('SELECT id FROM conversations WHERE id = ?', [id])
      if (!conv) throw new NotFoundError('conversation not found')
      const body = addContextBody.parse(req.body)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const kc = queryOne<any>('SELECT id FROM knowledge_captures WHERE id = ?', [body.knowledgeCaptureId])
      if (!kc) throw new NotFoundError('knowledge capture not found')
      const ctxId = randomUUID()
      run(
        'INSERT OR IGNORE INTO conversation_context (id, conversation_id, knowledge_capture_id) VALUES (?, ?, ?)',
        [ctxId, id, body.knowledgeCaptureId]
      )
      return { ok: true }
    }
  )

  // DELETE /api/assistant/conversations/:id/context  — remove a knowledge capture from context
  // Body: { knowledgeCaptureId }
  app.delete(
    '/api/assistant/conversations/:id/context',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id } = req.params as { id: string }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const conv = queryOne<any>('SELECT id FROM conversations WHERE id = ?', [id])
      if (!conv) throw new NotFoundError('conversation not found')
      const body = removeContextBody.parse(req.body)
      run('DELETE FROM conversation_context WHERE conversation_id = ? AND knowledge_capture_id = ?', [
        id,
        body.knowledgeCaptureId
      ])
      return { ok: true }
    }
  )
}
