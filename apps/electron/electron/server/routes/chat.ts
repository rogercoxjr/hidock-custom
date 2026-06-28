/**
 * Chat REST router (0c-3)
 *
 * Covers:
 *   GET    /api/chat/history?limit=   — fetch chat message history (most-recent last)
 *   POST   /api/chat/messages         — add a chat message
 *   DELETE /api/chat/history          — clear all chat messages
 *
 * IPC channels served: db:get-chat-history, db:add-chat-message, db:clear-chat-history,
 *                       chat:getHistory, chat:addMessage, chat:clearHistory
 */

import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getChatHistory, addChatMessage, clearChatHistory } from '../../main/services/database'
import { BadRequestError } from './_errors'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const historyQ = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50)
})

const addMessageBody = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
  sources: z.string().optional()
})

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function registerChat(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------
  // GET /api/chat/history?limit=
  // Returns: ChatMessage[]  (chronological order — oldest first)
  // IPC: db:get-chat-history, chat:getHistory
  // ------------------------------------------------------------------
  app.get('/api/chat/history', { preHandler: [app.requireAuth] }, async (req) => {
    const q = historyQ.safeParse(req.query)
    if (!q.success) throw new BadRequestError('invalid query params')
    return getChatHistory(q.data.limit)
  })

  // ------------------------------------------------------------------
  // POST /api/chat/messages
  // Body: { role, content, sources? }
  // Returns: { id, role, content, sources }
  // IPC: db:add-chat-message, chat:addMessage
  // ------------------------------------------------------------------
  app.post(
    '/api/chat/messages',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const body = addMessageBody.parse(req.body)
      const id = addChatMessage(body.role, body.content, body.sources)
      return { id, role: body.role, content: body.content, sources: body.sources ?? null }
    }
  )

  // ------------------------------------------------------------------
  // DELETE /api/chat/history
  // Returns: { ok: true }
  // IPC: db:clear-chat-history, chat:clearHistory
  // ------------------------------------------------------------------
  app.delete(
    '/api/chat/history',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async () => {
      clearChatHistory()
      return { ok: true }
    }
  )
}
