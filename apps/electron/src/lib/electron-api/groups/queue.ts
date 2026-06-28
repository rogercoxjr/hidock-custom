/**
 * queue.ts — REST SDK group for the queue namespace.
 *
 * Per CONTRACTS.md (Queue table):
 *   queue.getItems — RAW-THROW; bare any[].
 *
 * Note: recordings.getTranscriptionQueue also hits GET /api/queue?status= and is
 * the active call site (useTranscriptionSync.ts:24,126).  queue.getItems is the
 * no-call-site twin (db:get-queue) — both are implemented; shape tested by type.
 */

import type { Http } from '../http'

export interface QueueDeps {
  http: Http
}

export function makeQueueGroup({ http }: QueueDeps) {
  return {
    // -------------------------------------------------------------------------
    // RAW-THROW: bare any[] on 2xx; throw on error
    // -------------------------------------------------------------------------

    async getItems(status?: string): Promise<any[]> {
      const qs = status !== undefined ? `?status=${encodeURIComponent(status)}` : ''
      const r = await http.get(`/api/queue${qs}`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as any[]
    },
  }
}

export type QueueGroup = ReturnType<typeof makeQueueGroup>
