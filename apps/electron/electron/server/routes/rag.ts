/**
 * RAG REST router (0c-4)
 *
 * Endpoint table:
 *   GET    /api/rag/status                   — RAGStatus (ollamaAvailable, documentCount, etc.)
 *   GET    /api/rag/stats                    — { documentCount, meetingCount, sessionCount }
 *   POST   /api/rag/chat                     — full blocking chat (no token streaming over HTTP)
 *   POST   /api/rag/cancel                   — cancel an in-flight request for a sessionId
 *   POST   /api/rag/sessions/:sessionId/clear — clear session history
 *   POST   /api/rag/sessions/:sessionId/trim  — removeLastMessages(sessionId, count)
 *   POST   /api/rag/summarize-meeting        — summarizeMeeting(meetingId)
 *   POST   /api/rag/find-action-items        — findActionItems(meetingId?)
 *   POST   /api/rag/search                   — vectorStore.search(query, limit) → mapped results
 *   GET    /api/rag/chunks                   — getAllDocuments() mapped
 *   POST   /api/rag/index                    — vectorStore.indexTranscript (raised bodyLimit)
 *
 * IPC channels ported: rag:status, rag:stats, rag:chat, rag:cancel,
 *   rag:clear-session, rag:removeLastMessages, rag:summarize-meeting,
 *   rag:find-action-items, rag:search, rag:get-chunks, rag:index-transcript
 */

import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getRAGService } from '../../main/services/rag'
import { getVectorStore } from '../../main/services/vector-store'
import { getOllamaService } from '../../main/services/ollama'
import { getConfig } from '../../main/services/config'
import { RAGFilterSchema } from '../../main/validation/common'
import type { RAGFilter } from '../../main/types/api'
import { getMeetingsForContact, getMeetingsForProject } from '../../main/services/database'
import { BadRequestError, NotFoundError } from './_errors'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mirror the IPC handler's filter→meetingId extraction */
function extractMeetingIdsFromFilter(filter: RAGFilter): string[] | undefined {
  switch (filter.type) {
    case 'none':
      return undefined
    case 'meeting':
      return [filter.meetingId]
    case 'contact':
      return getMeetingsForContact(filter.contactId).map((m) => m.id)
    case 'project':
      return getMeetingsForProject(filter.projectId).map((m) => m.id)
    case 'dateRange':
      return undefined
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const chatBody = z.object({
  sessionId: z.string().min(1).max(100),
  message: z.string().min(1).max(10000),
  filter: RAGFilterSchema.optional()
})

const cancelBody = z.object({
  sessionId: z.string().min(1).max(100)
})

const trimBody = z.object({
  count: z.coerce.number().int().min(1)
})

const summarizeBody = z.object({
  meetingId: z.string().min(1)
})

const findActionItemsBody = z.object({
  meetingId: z.string().optional()
})

const searchBody = z.object({
  query: z.string().min(1).max(2000),
  limit: z.coerce.number().int().positive().max(50).default(5)
})

const indexBody = z.object({
  transcript: z.string().min(1),
  metadata: z.object({
    meetingId: z.string().optional(),
    recordingId: z.string().optional(),
    timestamp: z.string().optional(),
    subject: z.string().optional()
  })
})

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function registerRag(app: FastifyInstance): Promise<void> {
  // ─── GET /api/rag/status ─────────────────────────────────────────────────
  // IPC: rag:status
  app.get('/api/rag/status', { preHandler: [app.requireAuth] }, async () => {
    const config = getConfig()
    const vectorStore = getVectorStore()
    const needsLocalOllama =
      config.embeddings?.provider === 'ollama' || config.chat?.provider === 'ollama'
    const ollamaAvailable = needsLocalOllama ? await getOllamaService().isAvailable() : false
    const docCount = vectorStore.getDocumentCount()
    const meetingCount = vectorStore.getMeetingCount()
    return {
      ollamaAvailable,
      documentCount: docCount,
      meetingCount,
      ready: (!needsLocalOllama || ollamaAvailable) && docCount > 0
    }
  })

  // ─── GET /api/rag/stats ──────────────────────────────────────────────────
  // IPC: rag:stats
  app.get('/api/rag/stats', { preHandler: [app.requireAuth] }, async () => {
    return getRAGService().getStats()
  })

  // ─── POST /api/rag/chat ──────────────────────────────────────────────────
  // Full blocking HTTP response — no token streaming (token streaming rides /ws).
  // IPC: rag:chat
  app.post('/api/rag/chat', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const body = chatBody.parse(req.body)
    const rag = getRAGService()

    // Extract meetingFilter from optional filter, mirroring rag-handlers.ts
    let meetingFilter: string | undefined
    if (body.filter) {
      const meetingIds = extractMeetingIdsFromFilter(body.filter)
      if (meetingIds && meetingIds.length > 0) {
        meetingFilter = meetingIds[0]
      }
    }

    const response = await rag.chat(body.sessionId, body.message, meetingFilter)

    if (response.error) {
      throw new BadRequestError(response.error)
    }

    return { answer: response.answer, sources: response.sources }
  })

  // ─── POST /api/rag/cancel ────────────────────────────────────────────────
  // IPC: rag:cancel
  app.post('/api/rag/cancel', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { sessionId } = cancelBody.parse(req.body)
    const cancelled = getRAGService().cancelRequest(sessionId)
    return { cancelled }
  })

  // ─── POST /api/rag/sessions/:sessionId/clear ─────────────────────────────
  // IPC: rag:clear-session
  app.post(
    '/api/rag/sessions/:sessionId/clear',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { sessionId } = req.params as { sessionId: string }
      if (!sessionId) throw new BadRequestError('sessionId is required')
      getRAGService().clearSession(sessionId)
      return { ok: true }
    }
  )

  // ─── POST /api/rag/sessions/:sessionId/trim ──────────────────────────────
  // IPC: rag:removeLastMessages
  app.post(
    '/api/rag/sessions/:sessionId/trim',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { sessionId } = req.params as { sessionId: string }
      const { count } = trimBody.parse(req.body)
      const removed = getRAGService().removeLastMessages(sessionId, count)
      return { removed }
    }
  )

  // ─── POST /api/rag/summarize-meeting ─────────────────────────────────────
  // IPC: rag:summarize-meeting
  app.post(
    '/api/rag/summarize-meeting',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { meetingId } = summarizeBody.parse(req.body)
      const summary = await getRAGService().summarizeMeeting(meetingId)
      if (summary === null) {
        throw new NotFoundError('no transcripts found for this meeting')
      }
      return { summary }
    }
  )

  // ─── POST /api/rag/find-action-items ─────────────────────────────────────
  // IPC: rag:find-action-items
  app.post(
    '/api/rag/find-action-items',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { meetingId } = findActionItemsBody.parse(req.body)
      const actionItems = await getRAGService().findActionItems(meetingId)
      if (actionItems === null) {
        throw new NotFoundError('no action items found')
      }
      return { actionItems }
    }
  )

  // ─── POST /api/rag/search ─────────────────────────────────────────────────
  // IPC: rag:search  (also covers rag:globalSearch for /api/rag/global-search below)
  app.post('/api/rag/search', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const { query, limit } = searchBody.parse(req.body)
    const results = await getVectorStore().search(query, limit)
    return results.map((r) => ({
      content: r.document.content,
      meetingId: r.document.metadata.meetingId,
      subject: r.document.metadata.subject,
      score: r.score
    }))
  })

  // ─── GET /api/rag/chunks ─────────────────────────────────────────────────
  // IPC: rag:get-chunks
  app.get('/api/rag/chunks', { preHandler: [app.requireAuth] }, async () => {
    const documents = getVectorStore().getAllDocuments()
    return documents.map((doc) => ({
      id: doc.id,
      content: doc.content,
      meetingId: doc.metadata.meetingId,
      recordingId: doc.metadata.recordingId,
      chunkIndex: doc.metadata.chunkIndex,
      subject: doc.metadata.subject,
      timestamp: doc.metadata.timestamp,
      embeddingDimensions: doc.embedding.length
    }))
  })

  // ─── POST /api/rag/index ─────────────────────────────────────────────────
  // IPC: rag:index-transcript  (raised bodyLimit — transcripts can be large)
  app.post(
    '/api/rag/index',
    {
      preHandler: [app.requireAuth, app.requireSameOrigin],
      bodyLimit: 10 * 1024 * 1024 // 10 MB
    },
    async (req) => {
      const { transcript, metadata } = indexBody.parse(req.body)
      const count = await getVectorStore().indexTranscript(transcript, metadata)
      return { indexed: count }
    }
  )
}
