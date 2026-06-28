/**
 * assistant.ts — REST SDK group for the assistant namespace.
 *
 * Per CONTRACTS.md (Assistant table):
 *
 *   RAW-THROW:
 *     getConversations, createConversation, getMessages, addMessage, getContext
 *
 *   INLINE ({success, error?}):
 *     deleteConversation, updateConversationTitle, addContext, removeContext
 */

import type { Http } from '../http'
import type { Conversation, Message } from '../types'

export interface AssistantDeps {
  http: Http
}

export function makeAssistantGroup({ http }: AssistantDeps) {
  return {
    // -------------------------------------------------------------------------
    // RAW-THROW
    // -------------------------------------------------------------------------

    async getConversations(): Promise<Conversation[]> {
      const r = await http.get('/api/assistant/conversations')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as Conversation[]
    },

    async createConversation(title?: string): Promise<Conversation> {
      const body: Record<string, unknown> = {}
      if (title !== undefined) body.title = title
      const r = await http.post('/api/assistant/conversations', body)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as Conversation
    },

    async getMessages(conversationId: string): Promise<Message[]> {
      const r = await http.get(`/api/assistant/conversations/${conversationId}/messages`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as Message[]
    },

    async addMessage(
      conversationId: string,
      role: 'user' | 'assistant',
      content: string,
      sources?: string,
    ): Promise<Message> {
      const body: Record<string, unknown> = { role, content }
      if (sources !== undefined) body.sources = sources
      const r = await http.post(
        `/api/assistant/conversations/${conversationId}/messages`,
        body,
      )
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as Message
    },

    async getContext(conversationId: string): Promise<string[]> {
      const r = await http.get(`/api/assistant/conversations/${conversationId}/context`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as string[]
    },

    // -------------------------------------------------------------------------
    // INLINE: {success, error?}
    // -------------------------------------------------------------------------

    async deleteConversation(id: string): Promise<{ success: boolean; error?: string }> {
      const r = await http.del(`/api/assistant/conversations/${id}`)
      if (!r.ok) {
        return { success: false, error: r.error ?? `HTTP ${r.status}` }
      }
      return { success: true }
    },

    async updateConversationTitle(
      conversationId: string,
      title: string,
    ): Promise<{ success: boolean; error?: string }> {
      const r = await http.patch(`/api/assistant/conversations/${conversationId}`, { title })
      if (!r.ok) {
        return { success: false, error: r.error ?? `HTTP ${r.status}` }
      }
      return { success: true }
    },

    async addContext(
      conversationId: string,
      knowledgeCaptureId: string,
    ): Promise<{ success: boolean; error?: string }> {
      const r = await http.post(`/api/assistant/conversations/${conversationId}/context`, {
        knowledgeCaptureId,
      })
      if (!r.ok) {
        return { success: false, error: r.error ?? `HTTP ${r.status}` }
      }
      return { success: true }
    },

    async removeContext(
      conversationId: string,
      knowledgeCaptureId: string,
    ): Promise<{ success: boolean; error?: string }> {
      const r = await http.del(`/api/assistant/conversations/${conversationId}/context`, {
        knowledgeCaptureId,
      })
      if (!r.ok) {
        return { success: false, error: r.error ?? `HTTP ${r.status}` }
      }
      return { success: true }
    },
  }
}

export type AssistantGroup = ReturnType<typeof makeAssistantGroup>
