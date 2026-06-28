/**
 * chat.ts — REST SDK group for the legacy chat-history namespace.
 *
 * Per CONTRACTS.md (Chat table):
 *
 *   RAW-THROW  — getHistory, addMessage
 *   BOOL       — clearHistory
 */

import type { Http } from '../http'

export interface ChatDeps {
  http: Http
}

export function makeChatGroup({ http }: ChatDeps) {
  return {
    // -------------------------------------------------------------------------
    // RAW-THROW
    // -------------------------------------------------------------------------

    async getHistory(limit?: number): Promise<any[]> {
      const qs = limit !== undefined ? `?limit=${limit}` : ''
      const r = await http.get(`/api/chat/history${qs}`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as any[]
    },

    async addMessage(
      role: 'user' | 'assistant',
      content: string,
      sources?: string,
    ): Promise<any> {
      const r = await http.post('/api/chat/messages', { role, content, sources })
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    // -------------------------------------------------------------------------
    // BOOL
    // -------------------------------------------------------------------------

    async clearHistory(): Promise<boolean> {
      const r = await http.del('/api/chat/history')
      return r.ok
    },
  }
}

export type ChatGroup = ReturnType<typeof makeChatGroup>
