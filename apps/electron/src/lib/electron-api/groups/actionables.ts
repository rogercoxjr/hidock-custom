/**
 * actionables.ts — REST SDK group for the actionables namespace.
 *
 * Per CONTRACTS.md (Actionables table):
 *
 *   RAW-THROW:
 *     getAll, getByMeeting
 *
 *   INLINE ({success, error?}):
 *     updateStatus
 *
 *   INLINE ({success, error?, data?}):
 *     generateOutput
 */

import type { Http } from '../http'
import type { Actionable } from '../types'

export interface ActionablesDeps {
  http: Http
}

export function makeActionablesGroup({ http }: ActionablesDeps) {
  return {
    // -------------------------------------------------------------------------
    // RAW-THROW
    // -------------------------------------------------------------------------

    async getAll(options?: { status?: string }): Promise<Actionable[]> {
      const params = new URLSearchParams()
      if (options?.status) params.set('status', options.status)
      const qs = params.toString()
      const r = await http.get(`/api/actionables${qs ? `?${qs}` : ''}`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as Actionable[]
    },

    async getByMeeting(meetingId: string): Promise<Actionable[]> {
      const r = await http.get(`/api/meetings/${meetingId}/actionables`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as Actionable[]
    },

    // -------------------------------------------------------------------------
    // INLINE: {success, error?}
    // -------------------------------------------------------------------------

    async updateStatus(
      id: string,
      status: string,
    ): Promise<{ success: boolean; error?: string }> {
      const r = await http.patch(`/api/actionables/${id}`, { status })
      if (!r.ok) {
        return { success: false, error: r.error ?? `HTTP ${r.status}` }
      }
      return { success: true }
    },

    // -------------------------------------------------------------------------
    // INLINE: {success, error?, data?}
    // -------------------------------------------------------------------------

    async generateOutput(
      actionableId: string,
    ): Promise<{ success: boolean; error?: string; data?: any }> {
      const r = await http.post(`/api/actionables/${actionableId}/generate-output`)
      if (!r.ok) {
        return { success: false, error: r.error ?? `HTTP ${r.status}` }
      }
      return { success: true, data: r.data }
    },
  }
}

export type ActionablesGroup = ReturnType<typeof makeActionablesGroup>
