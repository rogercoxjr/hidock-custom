/**
 * quality.ts — REST SDK group for the quality namespace.
 *
 * Per CONTRACTS.md (Quality table):
 *   All methods are RAW-THROW with no renderer call sites.
 *   Classified by type/endpoint per CONTRACTS.md instructions.
 */

import type { Http } from '../http'

export interface QualityDeps {
  http: Http
}

export function makeQualityGroup({ http }: QualityDeps) {
  return {
    // -------------------------------------------------------------------------
    // RAW-THROW (all — no renderer call sites, classify by type/endpoint)
    // -------------------------------------------------------------------------

    async get(recordingId: string): Promise<any> {
      const r = await http.get(`/api/recordings/${recordingId}/quality`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    async set(
      recordingId: string,
      quality: 'high' | 'medium' | 'low',
      reason?: string,
      assessedBy?: string,
    ): Promise<any> {
      const body: Record<string, unknown> = { quality }
      if (reason !== undefined) body.reason = reason
      if (assessedBy !== undefined) body.assessedBy = assessedBy
      const r = await http.put(`/api/recordings/${recordingId}/quality`, body)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    async autoAssess(recordingId: string): Promise<any> {
      const r = await http.post(`/api/recordings/${recordingId}/quality/auto-assess`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    async getByQuality(quality: 'high' | 'medium' | 'low'): Promise<any> {
      const r = await http.get(`/api/recordings?quality=${encodeURIComponent(quality)}`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return (r.data as { items: unknown[] }).items
    },

    async batchAutoAssess(recordingIds: string[]): Promise<any> {
      const r = await http.post('/api/quality/batch-assess', { ids: recordingIds })
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    async assessUnassessed(): Promise<any> {
      const r = await http.post('/api/quality/assess-unassessed')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },
  }
}

export type QualityGroup = ReturnType<typeof makeQualityGroup>
