/**
 * speakers.ts — REST SDK group for the speakers namespace (0c-5).
 *
 * Per CONTRACTS.md (Speakers table) all methods are RESULT.
 *
 * ERROR-OBJECT SYNTHESIS (CONTRACTS §error-detail):
 *   `speakers.reassignTurns` call site reads `res?.error?.message` (object), so
 *   for that method we synthesise `error: { message: r.error, details }`.
 *   All other speaker methods read `res.success` only; plain string error suffices.
 */

import type { Http } from '../http'
import type { Result, SuggestionView } from '../types'

export interface SpeakersDeps {
  http: Http
}

/** Synthesise an error object for call sites that read `result.error?.message`. */
function errObj(r: { error?: string; data?: unknown }): { message: string; details?: unknown } {
  return {
    message: r.error ?? 'Unknown error',
    details: (r.data as any)?.details,
  }
}

export function makeSpeakersGroup({ http }: SpeakersDeps) {
  return {
    // -------------------------------------------------------------------------
    // RESULT: assign
    // -------------------------------------------------------------------------

    async assign(request: {
      recordingId: string
      fileLabel: string
      contactId: string
      source?: 'user' | 'confirmed' | 'suggestion_confirmed'
    }): Promise<Result<{ recordingId: string; fileLabel: string; contactId: string }>> {
      const { recordingId, fileLabel, ...body } = request
      const r = await http.put(
        `/api/recordings/${recordingId}/speakers/${encodeURIComponent(fileLabel)}`,
        body,
      )
      if (!r.ok) {
        return { success: false, error: r.error as any }
      }
      return {
        success: true,
        data: r.data as { recordingId: string; fileLabel: string; contactId: string },
      }
    },

    // -------------------------------------------------------------------------
    // RESULT: merge
    // -------------------------------------------------------------------------

    async merge(request: {
      recordingId: string
      fromLabel: string
      toLabel: string
    }): Promise<Result<{ recordingId: string; fromLabel: string; toLabel: string }>> {
      const { recordingId, ...body } = request
      const r = await http.post(`/api/recordings/${recordingId}/speakers/merge`, body)
      if (!r.ok) {
        return { success: false, error: r.error as any }
      }
      return {
        success: true,
        data: r.data as { recordingId: string; fromLabel: string; toLabel: string },
      }
    },

    // -------------------------------------------------------------------------
    // RESULT: unassign
    // -------------------------------------------------------------------------

    async unassign(request: { recordingId: string; fileLabel: string }): Promise<Result<void>> {
      const { recordingId, fileLabel } = request
      const r = await http.del(
        `/api/recordings/${recordingId}/speakers/${encodeURIComponent(fileLabel)}`,
      )
      if (!r.ok) {
        return { success: false, error: r.error as any }
      }
      return { success: true, data: undefined }
    },

    // -------------------------------------------------------------------------
    // RESULT: getForRecording
    // -------------------------------------------------------------------------

    async getForRecording(
      recordingId: string,
    ): Promise<Result<Record<string, { contactId: string; contactName: string }>>> {
      const r = await http.get(`/api/recordings/${recordingId}/speakers`)
      if (!r.ok) {
        return { success: false, error: r.error as any }
      }
      return {
        success: true,
        data: r.data as Record<string, { contactId: string; contactName: string }>,
      }
    },

    // -------------------------------------------------------------------------
    // RESULT: getSuggestions
    // -------------------------------------------------------------------------

    async getSuggestions(recordingId: string): Promise<Result<SuggestionView[]>> {
      const r = await http.get(`/api/recordings/${recordingId}/speaker-suggestions`)
      if (!r.ok) {
        return { success: false, error: r.error as any }
      }
      return { success: true, data: r.data as SuggestionView[] }
    },

    // -------------------------------------------------------------------------
    // RESULT: reassignTurns — reads res?.error?.message (error obj synthesis)
    // -------------------------------------------------------------------------

    async reassignTurns(request: {
      recordingId: string
      sourceLabel: string
      anchorIndex: number
      anchorStartMs: number
      scope: 'one' | 'before' | 'after'
      target:
        | { kind: 'existingLabel'; label: string }
        | { kind: 'contact'; contactId: string }
        | { kind: 'newSpeaker' }
    }): Promise<
      Result<{ recordingId: string; targetLabel: string; rewrittenCount: number }>
    > {
      const { recordingId, ...body } = request
      const r = await http.post(`/api/recordings/${recordingId}/speakers/reassign`, body)
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return {
        success: true,
        data: r.data as { recordingId: string; targetLabel: string; rewrittenCount: number },
      }
    },

    // -------------------------------------------------------------------------
    // RESULT: dismissSuggestion
    // -------------------------------------------------------------------------

    async dismissSuggestion(id: string): Promise<Result<{ id: string }>> {
      const r = await http.post(`/api/speaker-suggestions/${id}/dismiss`)
      if (!r.ok) {
        return { success: false, error: r.error as any }
      }
      return { success: true, data: r.data as { id: string } }
    },

    // -------------------------------------------------------------------------
    // RESULT: acceptSuggestion
    // -------------------------------------------------------------------------

    async acceptSuggestion(id: string): Promise<Result<{ id: string }>> {
      const r = await http.post(`/api/speaker-suggestions/${id}/accept`)
      if (!r.ok) {
        return { success: false, error: r.error as any }
      }
      return { success: true, data: r.data as { id: string } }
    },

    // -------------------------------------------------------------------------
    // RESULT: setSelf
    // -------------------------------------------------------------------------

    async setSelf(request: {
      recordingId: string
      fileLabel: string
    }): Promise<
      Result<{ selfAssigned: boolean; needsSelfContact?: boolean; contactId?: string }>
    > {
      const { recordingId, fileLabel } = request
      const r = await http.post(
        `/api/recordings/${recordingId}/speakers/${encodeURIComponent(fileLabel)}/set-self`,
      )
      if (!r.ok) {
        return { success: false, error: r.error as any }
      }
      return {
        success: true,
        data: r.data as {
          selfAssigned: boolean
          needsSelfContact?: boolean
          contactId?: string
        },
      }
    },
  }
}

export type SpeakersGroup = ReturnType<typeof makeSpeakersGroup>
