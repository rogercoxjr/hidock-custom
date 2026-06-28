/**
 * meetings.ts — REST SDK group for the meetings namespace.
 *
 * Per CONTRACTS.md (Meetings table):
 *
 *   RAW-THROW  — meetings.getAll / getById / getByIds / getDetails
 *   RESULT     — meetings.update  (Result<any>; call site reads result.success/result.error as string)
 */

import type { Http } from '../http'
import type { Result } from '../types'

export interface MeetingsDeps {
  http: Http
}

export function makeMeetingsGroup({ http }: MeetingsDeps) {
  return {
    // -------------------------------------------------------------------------
    // RAW-THROW: bare body on 2xx; throw on error
    // -------------------------------------------------------------------------

    async getAll(startDate?: string, endDate?: string): Promise<any[]> {
      const params = new URLSearchParams()
      if (startDate !== undefined) params.set('startDate', startDate)
      if (endDate !== undefined) params.set('endDate', endDate)
      const qs = params.toString()
      const r = await http.get(`/api/meetings${qs ? `?${qs}` : ''}`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as any[]
    },

    async getById(id: string): Promise<any> {
      const r = await http.get(`/api/meetings/${id}`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    async getByIds(ids: string[]): Promise<Record<string, any>> {
      const r = await http.post('/api/meetings/by-ids', { ids })
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as Record<string, any>
    },

    async getDetails(id: string): Promise<any> {
      const r = await http.get(`/api/meetings/${id}/details`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    // -------------------------------------------------------------------------
    // RESULT: {success:true,data} on 2xx; {success:false,error} on error.
    // Call site reads result.error as a string (RecordingLinkDialog, MeetingDetail).
    // -------------------------------------------------------------------------

    async update(request: {
      id: string
      subject?: string
      start_time?: string
      end_time?: string
      location?: string | null
      description?: string | null
    }): Promise<Result<any>> {
      const { id, ...body } = request
      const r = await http.patch(`/api/meetings/${id}`, body)
      if (!r.ok) {
        return { success: false, error: r.error ?? `HTTP ${r.status}` } as any
      }
      return { success: true, data: r.data } as any
    },
  }
}

export type MeetingsGroup = ReturnType<typeof makeMeetingsGroup>
