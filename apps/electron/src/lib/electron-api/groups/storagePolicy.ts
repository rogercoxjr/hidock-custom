/**
 * storagePolicy.ts — REST SDK group for the storagePolicy namespace (0c-5).
 *
 * Per CONTRACTS.md (Storage Policy table) all methods are RAW-THROW.
 * No renderer call sites found — classified by type/endpoint per CONTRACTS instructions.
 */

import type { Http } from '../http'

export interface StoragePolicyDeps {
  http: Http
}

export function makeStoragePolicyGroup({ http }: StoragePolicyDeps) {
  return {
    // -------------------------------------------------------------------------
    // RAW-THROW: getByTier
    // -------------------------------------------------------------------------

    async getByTier(tier: 'hot' | 'warm' | 'cold' | 'archive'): Promise<any> {
      const r = await http.get(
        `/api/storage-policy/by-tier?tier=${encodeURIComponent(tier)}`,
      )
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    // -------------------------------------------------------------------------
    // RAW-THROW: getCleanupSuggestions
    // -------------------------------------------------------------------------

    async getCleanupSuggestions(
      minAgeOverride?: Partial<Record<'hot' | 'warm' | 'cold' | 'archive', number>>,
    ): Promise<any> {
      // CONTRACTS.md specifies GET /api/storage-policy/cleanup-suggestions.
      // Pass minAgeOverride as JSON-encoded query param so GET semantics are preserved.
      const params = new URLSearchParams()
      if (minAgeOverride !== undefined) {
        params.set('minAgeOverride', JSON.stringify(minAgeOverride))
      }
      const qs = params.toString()
      const r = await http.get(
        `/api/storage-policy/cleanup-suggestions${qs ? `?${qs}` : ''}`,
      )
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    // -------------------------------------------------------------------------
    // RAW-THROW: getCleanupSuggestionsForTier
    // -------------------------------------------------------------------------

    async getCleanupSuggestionsForTier(
      tier: 'hot' | 'warm' | 'cold' | 'archive',
      minAgeDays?: number,
    ): Promise<any> {
      const params = new URLSearchParams()
      params.set('tier', tier)
      if (minAgeDays !== undefined) params.set('minAgeDays', String(minAgeDays))
      const r = await http.get(
        `/api/storage-policy/cleanup-suggestions?${params.toString()}`,
      )
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    // -------------------------------------------------------------------------
    // RAW-THROW: executeCleanup
    // -------------------------------------------------------------------------

    async executeCleanup(recordingIds: string[], archive?: boolean): Promise<any> {
      const r = await http.post('/api/storage-policy/execute-cleanup', {
        recordingIds,
        archive,
      })
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    // -------------------------------------------------------------------------
    // RAW-THROW: getStats
    // -------------------------------------------------------------------------

    async getStats(): Promise<any> {
      const r = await http.get('/api/storage-policy/stats')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    // -------------------------------------------------------------------------
    // RAW-THROW: initializeUntiered
    // -------------------------------------------------------------------------

    async initializeUntiered(): Promise<any> {
      const r = await http.post('/api/storage-policy/initialize-untiered')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    // -------------------------------------------------------------------------
    // RAW-THROW: assignTier
    // -------------------------------------------------------------------------

    async assignTier(
      recordingId: string,
      quality: 'high' | 'medium' | 'low',
    ): Promise<any> {
      const r = await http.post('/api/storage-policy/assign-tier', {
        recordingId,
        quality,
      })
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },
  }
}

export type StoragePolicyGroup = ReturnType<typeof makeStoragePolicyGroup>
