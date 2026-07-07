/**
 * recordings.ts — REST SDK group for the recordings namespace.
 *
 * Per CONTRACTS.md (Recordings table) every method returns EXACTLY the shape
 * its call site destructures.  Classifications drive the adapter pattern:
 *
 *   RAW-THROW  — 2xx → bare body; error → throw. getAll unwraps .items.
 *   INLINE     — builds {success,…} inline; NEVER throws.
 *   STRING|FALSE — id string on 2xx; false on error.
 *   BOOL       — true on 2xx; false on error.
 *   DROPPED    — no REST endpoint; return a safe stub.
 *
 * getPage({limit,offset,status}) → {items,total} is the Task 5b paginated
 * counterpart to getAll.  It does NOT unwrap .items — the caller wants the
 * full envelope.  It does NOT break getAll.
 */

import type { Http } from '../http'

export interface RecordingsDeps {
  http: Http
}

/** Minimal re-export so index.ts can pick up the type for recordings.getPage. */
export interface RecordingsPageResult {
  items: any[]
  total: number
}

export function makeRecordingsGroup({ http }: RecordingsDeps) {
  return {
    // -------------------------------------------------------------------------
    // RAW-THROW: bare body on 2xx; throw on error
    // -------------------------------------------------------------------------

    /** Returns bare any[] — unwraps {items,total} envelope from 0c-2. */
    async getAll(): Promise<any[]> {
      const r = await http.get('/api/recordings?limit=1000&offset=0')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      const body = r.data as { items: any[]; total: number }
      return body.items
    },

    /** Paginated variant — returns {items,total} for virtualized Library (Task 5b). */
    async getPage({
      limit,
      offset,
      status,
    }: {
      limit?: number
      offset?: number
      status?: string
    }): Promise<RecordingsPageResult> {
      const params = new URLSearchParams()
      if (limit !== undefined) params.set('limit', String(limit))
      if (offset !== undefined) params.set('offset', String(offset))
      if (status !== undefined) params.set('status', status)
      const qs = params.toString()
      const r = await http.get(`/api/recordings${qs ? `?${qs}` : ''}`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as RecordingsPageResult
    },

    /** 404 → throw. */
    async getById(id: string): Promise<any> {
      const r = await http.get(`/api/recordings/${id}`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    async getForMeeting(meetingId: string): Promise<any[]> {
      const r = await http.get(`/api/meetings/${meetingId}/recordings`)
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as any[]
    },

    /** RAW-THROW/VOID — awaited for side-effect; return value ignored. */
    async updateStatus(id: string, status: string): Promise<any> {
      const r = await http.patch(`/api/recordings/${id}`, { status })
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    async linkToMeeting(
      recordingId: string,
      meetingId: string,
      confidence: number,
      method: string,
    ): Promise<any> {
      const r = await http.post(`/api/recordings/${recordingId}/link-meeting`, {
        meetingId,
        confidence,
        method,
      })
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data
    },

    async getTranscriptionQueue(): Promise<any[]> {
      const r = await http.get('/api/queue')
      if (!r.ok) {
        throw new Error(r.error ?? `HTTP ${r.status}`)
      }
      return r.data as any[]
    },

    // -------------------------------------------------------------------------
    // INLINE: build exact {success,…} inline; NEVER throws
    // -------------------------------------------------------------------------

    async updateRecordingStatus(
      id: string,
      status: string,
    ): Promise<{ success: boolean; data?: any; error?: string }> {
      const r = await http.patch(`/api/recordings/${id}`, { status })
      if (!r.ok) {
        return { success: false, error: r.error }
      }
      return { success: true, data: r.data }
    },

    async updateTranscriptionStatus(
      id: string,
      status: string,
    ): Promise<{ success: boolean; data?: any; error?: string }> {
      const r = await http.patch(`/api/recordings/${id}`, { transcriptionStatus: status })
      if (!r.ok) {
        return { success: false, error: r.error }
      }
      return { success: true, data: r.data }
    },

    async deleteBatch(ids: string[]): Promise<{
      success: boolean
      deleted: number
      failed: number
      errors: Array<{ id: string; error: string }>
    }> {
      const r = await http.post('/api/recordings/batch-delete', { ids })
      if (!r.ok) {
        return { success: false, deleted: 0, failed: ids.length, errors: [] }
      }
      return r.data as { success: boolean; deleted: number; failed: number; errors: Array<{ id: string; error: string }> }
    },

    async getCandidates(
      recordingId: string,
    ): Promise<{ success: boolean; data: any[]; error?: string }> {
      const r = await http.get(`/api/recordings/${recordingId}/candidates`)
      if (!r.ok) {
        return { success: false, data: [], error: r.error }
      }
      return { success: true, data: r.data as any[] }
    },

    async getMeetingsNearDate(
      date: string,
    ): Promise<{ success: boolean; data: any[]; error?: string }> {
      const r = await http.get(`/api/recordings/meetings-near-date?date=${encodeURIComponent(date)}`)
      if (!r.ok) {
        return { success: false, data: [], error: r.error }
      }
      return { success: true, data: r.data as any[] }
    },

    async selectMeeting(
      recordingId: string,
      meetingId: string | null,
    ): Promise<{ success: boolean; error?: string }> {
      const r = await http.post(`/api/recordings/${recordingId}/select-meeting`, { meetingId })
      if (!r.ok) {
        return { success: false, error: r.error }
      }
      return { success: true }
    },

    /** DROPPED: native OS picker → browser <input type=file> in Task 10.
     *  Return safe stub so existing call sites don't crash before Task 10. */
    async addExternal(): Promise<{ success: boolean; recording?: any; error?: string }> {
      return { success: false, error: 'addExternal is not supported in web mode — use file upload' }
    },

    /** Re-pointed to POST /api/recordings/upload (multipart). */
    async addExternalByPath(
      filePath: string,
    ): Promise<{ success: boolean; recording?: any; error?: string }> {
      // In the browser context a "path" has no filesystem meaning; best-effort
      // pass it as a filename hint in the form body.  Full Task 10 upload flow
      // will replace this with a real <input> Blob upload.
      const formData = new FormData()
      formData.append('path', filePath)

      // Use http.postForm so the 401 onUnauthorized hook fires and same-origin
      // enforcement applies — raw fetch is no longer used here.
      const r = await http.postForm('/api/recordings/upload', formData)

      if (!r.ok) {
        return { success: false, error: r.error }
      }
      return { success: true, recording: (r.data as any)?.recording }
    },

    async cancelTranscription(recordingId: string): Promise<{ success: boolean }> {
      const r = await http.post(`/api/recordings/${recordingId}/transcription/cancel`)
      if (!r.ok) {
        return { success: false }
      }
      return { success: true }
    },

    async cancelAllTranscriptions(): Promise<{ success: boolean; count: number }> {
      const r = await http.post('/api/queue/cancel-all')
      if (!r.ok) {
        return { success: false, count: 0 }
      }
      const body = r.data as { success?: boolean; count?: number }
      return { success: body?.success ?? true, count: body?.count ?? 0 }
    },

    async getTranscriptionStatus(): Promise<{
      isProcessing: boolean
      pendingCount: number
      processingCount: number
    }> {
      const r = await http.get('/api/queue/status')
      if (!r.ok) {
        return { isProcessing: false, pendingCount: 0, processingCount: 0 }
      }
      return r.data as { isProcessing: boolean; pendingCount: number; processingCount: number }
    },

    async validateTranscriptionConfig(): Promise<{
      ok: boolean
      problems: Array<{ stage: string; provider: string; problem: string }>
    }> {
      const r = await http.get('/api/transcription/config/validate')
      if (!r.ok) {
        return { ok: false, problems: [] }
      }
      return r.data as { ok: boolean; problems: Array<{ stage: string; provider: string; problem: string }> }
    },

    async resummarize(recordingId: string): Promise<{ success: boolean; error?: string }> {
      const r = await http.post(`/api/recordings/${recordingId}/resummarize`, {})
      if (!r.ok) {
        return { success: false, error: r.error }
      }
      return { success: true }
    },

    async retryAllFailed(): Promise<{ success: boolean; count: number }> {
      const r = await http.post('/api/queue/retry-failed')
      if (!r.ok) {
        return { success: false, count: 0 }
      }
      const body = r.data as { success?: boolean; count?: number }
      return { success: body?.success ?? true, count: body?.count ?? 0 }
    },

    // -------------------------------------------------------------------------
    // STRING|FALSE: id string on 2xx; false on error
    // -------------------------------------------------------------------------

    /** FORCE re-transcribe path — distinct from addToQueue (see CONTRACTS §0c-2b §9). */
    async transcribe(recordingId: string): Promise<string | false> {
      const r = await http.post(`/api/recordings/${recordingId}/transcribe`, { force: true })
      if (!r.ok) {
        return false
      }
      const id = (r.data as any)?.id ?? (r.data as any)?.queueItemId
      if (typeof id !== 'string') {
        console.warn('[recordings.transcribe] 2xx response missing id/queueItemId — actual body:', r.data)
        return false
      }
      return id
    },

    async addToQueue(recordingId: string): Promise<string | false> {
      const r = await http.post(`/api/recordings/${recordingId}/transcribe`)
      if (!r.ok) {
        return false
      }
      const id = (r.data as any)?.id ?? (r.data as any)?.queueItemId
      if (typeof id !== 'string') {
        console.warn('[recordings.addToQueue] 2xx response missing id/queueItemId — actual body:', r.data)
        return false
      }
      return id
    },

    // -------------------------------------------------------------------------
    // BOOL: true on 2xx; false on error
    // -------------------------------------------------------------------------

    async delete(id: string): Promise<boolean> {
      const r = await http.del(`/api/recordings/${id}`)
      return r.ok
    },

    async processQueue(): Promise<boolean> {
      const r = await http.post('/api/queue/process')
      return r.ok
    },

    async updateQueueItem(
      id: string,
      status: string,
      errorMessage?: string,
    ): Promise<boolean> {
      const body: Record<string, string> = { status }
      if (errorMessage !== undefined) body.errorMessage = errorMessage
      const r = await http.patch(`/api/queue/${id}`, body)
      return r.ok
    },

    async isSummaryStale(recordingId: string): Promise<boolean> {
      const r = await http.get(`/api/recordings/${recordingId}/summary-stale`)
      if (!r.ok) return false
      // Server returns {stale: boolean} or bare boolean
      const body = r.data
      if (typeof body === 'boolean') return body
      return Boolean((body as any)?.stale)
    },
  }
}

export type RecordingsGroup = ReturnType<typeof makeRecordingsGroup>
