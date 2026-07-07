/**
 * transcripts.ts — REST SDK group for the transcripts namespace.
 *
 * Per CONTRACTS.md (Transcripts table) classifications:
 *
 *   RAW-THROW — 2xx → bare body; error → throw.
 *   RESULT    — {success:true,data} on 2xx / {success:false,error} on error; never throws.
 *               transcripts.export call site reads res.error.message (object), so the
 *               error field must be synthesized as { message, details? }.
 */

import type { Http } from '../http'
import type { Result } from '../types'

export interface TranscriptsDeps {
  http: Http
}

export function makeTranscriptsGroup({ http }: TranscriptsDeps) {
  return {
    // -------------------------------------------------------------------------
    // RAW-THROW: bare body on 2xx; throw on error
    // -------------------------------------------------------------------------

    async getByRecordingId(recordingId: string): Promise<any> {
      const r = await http.get(`/api/recordings/${recordingId}/transcript`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    async getByRecordingIds(recordingIds: string[]): Promise<Record<string, any>> {
      // Route parses `{ ids }` (zod); sending `recordingIds` 400s → transcripts never load.
      const r = await http.post('/api/transcripts/by-recording-ids', { ids: recordingIds })
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as Record<string, any>
    },

    async search(query: string): Promise<any[]> {
      const r = await http.get(`/api/transcripts/search?q=${encodeURIComponent(query)}`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as any[]
    },

    // -------------------------------------------------------------------------
    // RESULT: {success,data} on 2xx / {success,error} on error; never throws.
    // transcripts.export call site reads res.error.message — synthesize object.
    // -------------------------------------------------------------------------

    async updateTurns(request: {
      recordingId: string
      turns: unknown[]
    }): Promise<Result<{ recordingId: string }>> {
      const r = await http.patch(
        `/api/recordings/${request.recordingId}/transcript/turns`,
        { turns: request.turns },
      )
      if (!r.ok) {
        const details = (r.data as any)?.details
        return {
          success: false,
          error: { message: r.error ?? `HTTP ${r.status}`, ...(details ? { details } : {}) } as any,
        } as unknown as Result<{ recordingId: string }>
      }
      return { success: true, data: r.data as { recordingId: string } }
    },

    /**
     * export — RESULT; call site reads res.error.message so error is synthesized
     * as { message: string, details?: unknown } instead of a bare string.
     * Browser download (anchor+Blob) is handled by Task 10; here we return the
     * body as a string so Task 10 can consume it from res.data.
     */
    async export(
      recordingId: string,
      format: 'csv' | 'srt' | 'json',
    ): Promise<Result<string | null>> {
      const r = await http.post(
        `/api/recordings/${recordingId}/transcript/export?format=${encodeURIComponent(format)}`,
      )
      if (!r.ok) {
        const details = (r.data as any)?.details
        return {
          success: false,
          error: { message: r.error ?? `HTTP ${r.status}`, ...(details ? { details } : {}) } as any,
        } as unknown as Result<string | null>
      }
      // On 2xx the body is the file content (text) or null (cancelled).
      const body = r.data
      const content: string | null =
        body === null || body === undefined
          ? null
          : typeof body === 'string'
            ? body
            : JSON.stringify(body)
      return { success: true, data: content }
    },
  }
}

export type TranscriptsGroup = ReturnType<typeof makeTranscriptsGroup>
