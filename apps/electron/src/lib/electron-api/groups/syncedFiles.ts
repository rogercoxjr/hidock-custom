/**
 * syncedFiles.ts — REST SDK group for the syncedFiles namespace.
 *
 * Per CONTRACTS.md (Synced files table):
 *
 *   BOOL       — isFileSynced, remove
 *   RAW-THROW  — getSyncedFile, getAll, add, getFilenames
 */

import type { Http } from '../http'

export interface SyncedFilesDeps {
  http: Http
}

/** Shape of a synced-file row (mirrors types.ts ElectronAPI.syncedFiles.getSyncedFile). */
interface SyncedFileRow {
  id: string
  original_filename: string
  local_filename: string
  file_path: string
  file_size?: number
  synced_at: string
}

export function makeSyncedFilesGroup({ http }: SyncedFilesDeps) {
  return {
    // -------------------------------------------------------------------------
    // BOOL
    // -------------------------------------------------------------------------

    async isFileSynced(originalFilename: string): Promise<boolean> {
      const r = await http.get(
        `/api/synced-files/lookup?filename=${encodeURIComponent(originalFilename)}`,
      )
      if (!r.ok) return false
      const body = r.data as any
      return Boolean(body?.synced ?? body?.found ?? r.ok)
    },

    async remove(originalFilename: string): Promise<boolean> {
      const r = await http.del(
        `/api/synced-files?filename=${encodeURIComponent(originalFilename)}`,
      )
      return r.ok
    },

    // -------------------------------------------------------------------------
    // RAW-THROW
    // -------------------------------------------------------------------------

    async getSyncedFile(originalFilename: string): Promise<SyncedFileRow | undefined> {
      const r = await http.get(
        `/api/synced-files/lookup?filename=${encodeURIComponent(originalFilename)}`,
      )
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      // 404 with empty/null body means not found → undefined
      if (!r.data) return undefined
      return r.data as SyncedFileRow
    },

    async getAll(): Promise<SyncedFileRow[]> {
      const r = await http.get('/api/synced-files')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as SyncedFileRow[]
    },

    async add(
      originalFilename: string,
      localFilename: string,
      filePath: string,
      fileSize?: number,
    ): Promise<string> {
      const r = await http.post('/api/synced-files', {
        originalFilename,
        localFilename,
        filePath,
        fileSize,
      })
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      // Server returns the new row id as a string or in {id} envelope.
      const body = r.data
      if (typeof body === 'string') return body
      return (body as any)?.id ?? ''
    },

    async getFilenames(): Promise<string[]> {
      const r = await http.get('/api/synced-files/filenames')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as string[]
    },
  }
}

export type SyncedFilesGroup = ReturnType<typeof makeSyncedFilesGroup>
