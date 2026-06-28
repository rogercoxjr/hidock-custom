/**
 * knowledge.ts — REST SDK group for the knowledge namespace.
 *
 * Per CONTRACTS.md (Knowledge table):
 *
 *   RAW-THROW  — knowledge.getAll / getById / getByIds
 *   INLINE     — knowledge.update → {success, error?}
 */

import type { Http } from '../http'
import type { KnowledgeCapture } from '../types'

export interface KnowledgeDeps {
  http: Http
}

export function makeKnowledgeGroup({ http }: KnowledgeDeps) {
  return {
    // -------------------------------------------------------------------------
    // RAW-THROW
    // -------------------------------------------------------------------------

    async getAll(options?: {
      limit?: number
      offset?: number
      status?: string
      quality?: string
      category?: string
    }): Promise<KnowledgeCapture[]> {
      const params = new URLSearchParams()
      if (options?.limit !== undefined) params.set('limit', String(options.limit))
      if (options?.offset !== undefined) params.set('offset', String(options.offset))
      if (options?.status) params.set('status', options.status)
      if (options?.quality) params.set('quality', options.quality)
      if (options?.category) params.set('category', options.category)
      const qs = params.toString()
      const r = await http.get(`/api/knowledge${qs ? `?${qs}` : ''}`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as KnowledgeCapture[]
    },

    async getById(id: string): Promise<KnowledgeCapture | null> {
      const r = await http.get(`/api/knowledge/${id}`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as KnowledgeCapture | null
    },

    async getByIds(ids: string[]): Promise<KnowledgeCapture[]> {
      const r = await http.post('/api/knowledge/by-ids', { ids })
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as KnowledgeCapture[]
    },

    // -------------------------------------------------------------------------
    // INLINE: {success, error?}
    // -------------------------------------------------------------------------

    async update(
      id: string,
      updates: Partial<KnowledgeCapture>,
    ): Promise<{ success: boolean; error?: string }> {
      const r = await http.patch(`/api/knowledge/${id}`, updates)
      if (!r.ok) {
        return { success: false, error: r.error ?? `HTTP ${r.status}` }
      }
      return { success: true }
    },
  }
}

export type KnowledgeGroup = ReturnType<typeof makeKnowledgeGroup>
