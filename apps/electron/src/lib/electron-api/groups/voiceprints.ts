/**
 * voiceprints.ts — REST SDK group for the voiceprints namespace (0c-5).
 *
 * Per CONTRACTS.md (Voiceprints table) all methods are RESULT.
 * Call sites read `result.success` / `result.data`; none read `result.error?.message`
 * as an object, so we use plain string errors (no errObj synthesis needed).
 */

import type { Http } from '../http'
import type { Result, VoiceprintSummary } from '../types'

export interface VoiceprintsDeps {
  http: Http
}

export function makeVoiceprintsGroup({ http }: VoiceprintsDeps) {
  return {
    // -------------------------------------------------------------------------
    // RESULT: listForContact
    // -------------------------------------------------------------------------

    async listForContact(contactId: string): Promise<Result<VoiceprintSummary[]>> {
      const r = await http.get(`/api/contacts/${contactId}/voiceprints`)
      if (!r.ok) {
        return { success: false, error: r.error as any }
      }
      return { success: true, data: r.data as VoiceprintSummary[] }
    },

    // -------------------------------------------------------------------------
    // RESULT: disable
    // -------------------------------------------------------------------------

    async disable(id: string): Promise<Result<void>> {
      const r = await http.patch(`/api/voiceprints/${id}`, { enabled: false })
      if (!r.ok) {
        return { success: false, error: r.error as any }
      }
      return { success: true, data: undefined }
    },

    // -------------------------------------------------------------------------
    // RESULT: enable
    // -------------------------------------------------------------------------

    async enable(id: string): Promise<Result<void>> {
      const r = await http.patch(`/api/voiceprints/${id}`, { enabled: true })
      if (!r.ok) {
        return { success: false, error: r.error as any }
      }
      return { success: true, data: undefined }
    },

    // -------------------------------------------------------------------------
    // RESULT: delete
    // -------------------------------------------------------------------------

    async delete(id: string): Promise<Result<void>> {
      const r = await http.del(`/api/voiceprints/${id}`)
      if (!r.ok) {
        return { success: false, error: r.error as any }
      }
      return { success: true, data: undefined }
    },

    // -------------------------------------------------------------------------
    // RESULT: clearAllForContact
    // -------------------------------------------------------------------------

    async clearAllForContact(contactId: string): Promise<Result<{ deleted: number }>> {
      const r = await http.del(`/api/voiceprints?contactId=${encodeURIComponent(contactId)}`)
      if (!r.ok) {
        return { success: false, error: r.error as any }
      }
      return { success: true, data: r.data as { deleted: number } }
    },

    // -------------------------------------------------------------------------
    // RESULT: clearAll
    // -------------------------------------------------------------------------

    async clearAll(): Promise<Result<{ deleted: number }>> {
      const r = await http.del('/api/voiceprints')
      if (!r.ok) {
        return { success: false, error: r.error as any }
      }
      return { success: true, data: r.data as { deleted: number } }
    },

    // -------------------------------------------------------------------------
    // RESULT: findBySource
    // -------------------------------------------------------------------------

    async findBySource(
      recordingId: string,
      fileLabel: string,
      contactId?: string,
    ): Promise<Result<VoiceprintSummary[]>> {
      const params = new URLSearchParams()
      params.set('recordingId', recordingId)
      params.set('fileLabel', fileLabel)
      if (contactId !== undefined) params.set('contactId', contactId)
      const r = await http.get(`/api/voiceprints?${params.toString()}`)
      if (!r.ok) {
        return { success: false, error: r.error as any }
      }
      return { success: true, data: r.data as VoiceprintSummary[] }
    },
  }
}

export type VoiceprintsGroup = ReturnType<typeof makeVoiceprintsGroup>
