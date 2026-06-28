/**
 * diarization.ts — REST SDK group for the diarization namespace (0c-5).
 *
 * Per CONTRACTS.md (Diarization table) all methods are RESULT.
 * No renderer call sites found — classified by type signature per CONTRACTS instructions.
 */

import type { Http } from '../http'
import type { Result, DiarizationRun } from '../types'

export interface DiarizationDeps {
  http: Http
}

export function makeDiarizationGroup({ http }: DiarizationDeps) {
  return {
    // -------------------------------------------------------------------------
    // RESULT: getLatestRun
    // -------------------------------------------------------------------------

    async getLatestRun(recordingId: string): Promise<Result<DiarizationRun | null>> {
      const r = await http.get(`/api/recordings/${recordingId}/diarization`)
      if (!r.ok) {
        return { success: false, error: r.error as any }
      }
      return { success: true, data: r.data as DiarizationRun | null }
    },

    // -------------------------------------------------------------------------
    // RESULT: getRunsForRecording
    // -------------------------------------------------------------------------

    async getRunsForRecording(recordingId: string): Promise<Result<DiarizationRun[]>> {
      const r = await http.get(`/api/recordings/${recordingId}/diarization?all=1`)
      if (!r.ok) {
        return { success: false, error: r.error as any }
      }
      return { success: true, data: r.data as DiarizationRun[] }
    },
  }
}

export type DiarizationGroup = ReturnType<typeof makeDiarizationGroup>
