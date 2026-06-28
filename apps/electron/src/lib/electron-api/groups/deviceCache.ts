/**
 * deviceCache.ts — REST SDK group for the deviceCache namespace (0c-5).
 *
 * Per CONTRACTS.md (App-level cache / device-cache table):
 *
 *   deviceCache.getAll  — RAW-THROW: `GET /api/device-cache`; bare `any[]`
 *   deviceCache.saveAll — VOID: `PUT /api/device-cache`; awaited for side-effect
 *   deviceCache.clear   — VOID: `DELETE /api/device-cache`; awaited for side-effect
 */

import type { Http } from '../http'

export interface DeviceCacheDeps {
  http: Http
}

export function makeDeviceCacheGroup({ http }: DeviceCacheDeps) {
  return {
    // -------------------------------------------------------------------------
    // RAW-THROW: getAll
    // -------------------------------------------------------------------------

    async getAll(): Promise<any[]> {
      const r = await http.get('/api/device-cache')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as any[]
    },

    // -------------------------------------------------------------------------
    // VOID: saveAll
    // -------------------------------------------------------------------------

    async saveAll(files: any[]): Promise<void> {
      const r = await http.put('/api/device-cache', files)
      if (!r.ok) {
        console.warn('[deviceCache.saveAll] PUT /api/device-cache failed:', r.error ?? `HTTP ${r.status}`)
      }
    },

    // -------------------------------------------------------------------------
    // VOID: clear
    // -------------------------------------------------------------------------

    async clear(): Promise<void> {
      const r = await http.del('/api/device-cache')
      if (!r.ok) {
        console.warn('[deviceCache.clear] DELETE /api/device-cache failed:', r.error ?? `HTTP ${r.status}`)
      }
    },
  }
}

export type DeviceCacheGroup = ReturnType<typeof makeDeviceCacheGroup>
