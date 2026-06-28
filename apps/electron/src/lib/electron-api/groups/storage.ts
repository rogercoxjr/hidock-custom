/**
 * storage.ts — REST SDK group for the storage namespace (0c-5 subset).
 *
 * Per CONTRACTS.md (Storage table):
 *   storage.getInfo — RAW-THROW: `GET /api/storage/info`; bare `any`; call site reads `result`
 *   storage.openFolder / openFile / revealInFolder / readRecording / deleteRecording / saveRecording
 *     — DROPPED (0c §4: no server desktop); resolve safe defaults per type signature.
 */

import type { Http } from '../http'

export interface StorageDeps {
  http: Http
}

export function makeStorageGroup({ http }: StorageDeps) {
  return {
    // -------------------------------------------------------------------------
    // RAW-THROW: getInfo
    // -------------------------------------------------------------------------

    async getInfo(): Promise<any> {
      const r = await http.get('/api/storage/info')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    // -------------------------------------------------------------------------
    // DROPPED — Electron-ism; no server-side desktop; resolve safe defaults.
    // -------------------------------------------------------------------------

    async openFolder(_folder: 'recordings' | 'transcripts' | 'data'): Promise<boolean> {
      return false
    },

    async openFile(_filePath: string): Promise<{ success: boolean; error?: string }> {
      return { success: false, error: 'openFile is not available in browser mode' }
    },

    async revealInFolder(_filePath: string): Promise<{ success: boolean; error?: string }> {
      return { success: false, error: 'revealInFolder is not available in browser mode' }
    },

    async readRecording(
      _filePath: string,
    ): Promise<{ success: boolean; data?: string; error?: string }> {
      return { success: false, error: 'readRecording is not available in browser mode' }
    },

    async deleteRecording(_filePath: string): Promise<boolean> {
      return false
    },

    async saveRecording(
      _filename: string,
      _data: number[],
      _recordingDateIso?: string,
    ): Promise<string> {
      throw new Error('saveRecording is not available in browser mode')
    },
  }
}

export type StorageGroup = ReturnType<typeof makeStorageGroup>
