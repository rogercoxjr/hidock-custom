/**
 * calendar.ts — REST SDK group for the calendar namespace.
 *
 * Per CONTRACTS.md (Calendar table) all methods are RAW-THROW (or RAW-THROW/VOID).
 * Call sites await the returned value directly.
 */

import type { Http } from '../http'

export interface CalendarDeps {
  http: Http
}

export function makeCalendarGroup({ http }: CalendarDeps) {
  return {
    async sync(): Promise<any> {
      const r = await http.post('/api/calendar/sync')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    async clearAndSync(): Promise<any> {
      const r = await http.post('/api/calendar/sync?clear=1')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    async getLastSync(): Promise<string | null> {
      const r = await http.get('/api/calendar/last-sync')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as string | null
    },

    async setUrl(url: string): Promise<any> {
      const r = await http.patch('/api/calendar/settings', { url })
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    async toggleAutoSync(enabled: boolean): Promise<any> {
      const r = await http.patch('/api/calendar/settings', { autoSync: enabled })
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    async setInterval(minutes: number): Promise<any> {
      const r = await http.patch('/api/calendar/settings', { interval: minutes })
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    async getSettings(): Promise<any> {
      const r = await http.get('/api/calendar/settings')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },
  }
}

export type CalendarGroup = ReturnType<typeof makeCalendarGroup>
