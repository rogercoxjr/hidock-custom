/**
 * rag.ts — REST SDK group for the rag namespace.
 *
 * Per CONTRACTS.md (RAG table):
 *
 *   RESULT (error synthesized as {message,details?}):
 *     status, chat, summarizeMeeting, findActionItems, cancel,
 *     removeLastMessages, clearSession, globalSearch
 *
 *   RAW-THROW:
 *     chatLegacy, stats, indexTranscript, search, getChunks
 */

import type { Http } from '../http'
import type { Result, RAGChatRequest, RAGChatResponse, RAGStatus } from '../types'

export interface RagDeps {
  http: Http
}

/** Synthesise an error object for call sites that read `result.error?.message`. */
function errObj(r: { error?: string; data?: unknown }): { message: string; details?: unknown } {
  return {
    message: r.error ?? 'Unknown error',
    details: (r.data as any)?.details,
  }
}

export function makeRagGroup({ http }: RagDeps) {
  return {
    // -------------------------------------------------------------------------
    // RESULT (error as {message, details?})
    // -------------------------------------------------------------------------

    async status(): Promise<Result<RAGStatus>> {
      const r = await http.get('/api/rag/status')
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as RAGStatus }
    },

    async chat(request: RAGChatRequest): Promise<Result<RAGChatResponse>> {
      const r = await http.post('/api/rag/chat', request)
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as RAGChatResponse }
    },

    async summarizeMeeting(meetingId: string): Promise<Result<string>> {
      const r = await http.post('/api/rag/summarize-meeting', { meetingId })
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as string }
    },

    async findActionItems(meetingId?: string): Promise<Result<string>> {
      const body: Record<string, unknown> = {}
      if (meetingId !== undefined) body.meetingId = meetingId
      const r = await http.post('/api/rag/find-action-items', body)
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as string }
    },

    async cancel(sessionId: string): Promise<Result<boolean>> {
      const r = await http.post('/api/rag/cancel', { sessionId })
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as boolean }
    },

    async removeLastMessages(sessionId: string, count: number): Promise<Result<number>> {
      const r = await http.post('/api/rag/session/trim', { sessionId, count })
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as number }
    },

    async clearSession(sessionId: string): Promise<Result<void>> {
      const r = await http.post('/api/rag/session/clear', { sessionId })
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: undefined }
    },

    async globalSearch(
      query: string,
      limit?: number,
    ): Promise<Result<{ knowledge: any[]; people: any[]; projects: any[] }>> {
      const params = new URLSearchParams({ q: query, scope: 'global' })
      if (limit !== undefined) params.set('limit', String(limit))
      const r = await http.get(`/api/rag/search?${params.toString()}`)
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as { knowledge: any[]; people: any[]; projects: any[] } }
    },

    // -------------------------------------------------------------------------
    // RAW-THROW
    // -------------------------------------------------------------------------

    async chatLegacy(
      sessionId: string,
      message: string,
      meetingFilter?: string,
    ): Promise<{ answer: string; sources: Array<{ content: string; meetingId?: string; subject?: string; timestamp?: string; score: number }>; error?: string }> {
      const body: Record<string, unknown> = { sessionId, message }
      if (meetingFilter !== undefined) body.meetingFilter = meetingFilter
      const r = await http.post('/api/rag/chat', body)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as any
    },

    async stats(): Promise<{ documentCount: number; meetingCount: number; sessionCount: number }> {
      const r = await http.get('/api/rag/stats')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as any
    },

    async indexTranscript(
      transcript: string,
      metadata: { meetingId?: string; recordingId?: string; timestamp?: string; subject?: string },
    ): Promise<{ indexed: number }> {
      const r = await http.post('/api/rag/index', { transcript, metadata })
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as any
    },

    async search(
      query: string,
      limit?: number,
    ): Promise<Array<{ content: string; meetingId?: string; subject?: string; score: number }>> {
      const params = new URLSearchParams({ q: query })
      if (limit !== undefined) params.set('limit', String(limit))
      const r = await http.get(`/api/rag/search?${params.toString()}`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as any
    },

    async getChunks(): Promise<
      Array<{
        id: string
        content: string
        meetingId?: string
        recordingId?: string
        chunkIndex: number
        subject?: string
        timestamp?: string
        embeddingDimensions: number
      }>
    > {
      const r = await http.get('/api/rag/chunks')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as any
    },
  }
}

export type RagGroup = ReturnType<typeof makeRagGroup>
