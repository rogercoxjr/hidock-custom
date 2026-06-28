/**
 * recordings.test.ts — Shape-assertion tests for the recordings SDK group.
 *
 * Each test mocks http to feed a 2xx or a 4xx result, then asserts the
 * EXACT returned shape matches the CONTRACTS.md classification.
 *
 * HTTP mock pattern:
 *   http.get / post / patch / put / del are replaced with vi.fn().
 *   Each test configures mockResolvedValueOnce({ ok, status, data, error }).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeRecordingsGroup } from '../groups/recordings'
import type { Http } from '../http'

// ---------------------------------------------------------------------------
// Mock HTTP factory
// ---------------------------------------------------------------------------

function makeHttp() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
    postForm: vi.fn(),
  } as unknown as Http & {
    get: ReturnType<typeof vi.fn>
    post: ReturnType<typeof vi.fn>
    patch: ReturnType<typeof vi.fn>
    put: ReturnType<typeof vi.fn>
    del: ReturnType<typeof vi.fn>
    postForm: ReturnType<typeof vi.fn>
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok2xx(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, data })
}

function err4xx(status = 400, error = 'Bad Request', data?: unknown) {
  return Promise.resolve({ ok: false, status, error, data })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeRecordingsGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeRecordingsGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeRecordingsGroup({ http })
  })

  // -------------------------------------------------------------------------
  // RAW-THROW: getAll — unwraps .items
  // -------------------------------------------------------------------------

  it('getAll 2xx → bare any[] (unwraps .items)', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ items: [{ id: '1' }], total: 1 }))
    const result = await grp.getAll()
    expect(Array.isArray(result)).toBe(true)
    expect(result[0]).toEqual({ id: '1' })
  })

  it('getAll 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Server Error'))
    await expect(grp.getAll()).rejects.toThrow('Server Error')
  })

  // -------------------------------------------------------------------------
  // RAW-THROW: getPage — returns {items,total} without unwrapping
  // -------------------------------------------------------------------------

  it('getPage 2xx → {items,total}', async () => {
    const body = { items: [{ id: '2' }], total: 10 }
    http.get.mockResolvedValueOnce(ok2xx(body))
    const result = await grp.getPage({ limit: 20, offset: 0 })
    expect(result).toEqual(body)
    expect(result.total).toBe(10)
    expect(Array.isArray(result.items)).toBe(true)
  })

  it('getPage 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'Internal'))
    await expect(grp.getPage({ limit: 20, offset: 0 })).rejects.toThrow('Internal')
  })

  // -------------------------------------------------------------------------
  // RAW-THROW: getById
  // -------------------------------------------------------------------------

  it('getById 2xx → bare row', async () => {
    const row = { id: 'abc', filename: 'test.wav' }
    http.get.mockResolvedValueOnce(ok2xx(row))
    const result = await grp.getById('abc')
    expect(result).toEqual(row)
  })

  it('getById 404 → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    await expect(grp.getById('missing')).rejects.toThrow('Not Found')
  })

  // -------------------------------------------------------------------------
  // RAW-THROW: getForMeeting
  // -------------------------------------------------------------------------

  it('getForMeeting 2xx → bare any[]', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ id: '1' }]))
    const result = await grp.getForMeeting('m1')
    expect(Array.isArray(result)).toBe(true)
  })

  it('getForMeeting 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx())
    await expect(grp.getForMeeting('m1')).rejects.toThrow()
  })

  // -------------------------------------------------------------------------
  // RAW-THROW/VOID: updateStatus
  // -------------------------------------------------------------------------

  it('updateStatus 2xx → returns data (callers ignore)', async () => {
    http.patch.mockResolvedValueOnce(ok2xx({ updated: true }))
    const result = await grp.updateStatus('r1', 'transcribed')
    expect(result).toEqual({ updated: true })
  })

  it('updateStatus 4xx → throws', async () => {
    http.patch.mockResolvedValueOnce(err4xx())
    await expect(grp.updateStatus('r1', 'transcribed')).rejects.toThrow()
  })

  // -------------------------------------------------------------------------
  // INLINE: updateRecordingStatus
  // -------------------------------------------------------------------------

  it('updateRecordingStatus 2xx → {success:true,data}', async () => {
    http.patch.mockResolvedValueOnce(ok2xx({ id: 'r1', status: 'done' }))
    const result = await grp.updateRecordingStatus('r1', 'done')
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ id: 'r1', status: 'done' })
    expect(result.error).toBeUndefined()
  })

  it('updateRecordingStatus 4xx → {success:false,error}', async () => {
    http.patch.mockResolvedValueOnce(err4xx(400, 'invalid status'))
    const result = await grp.updateRecordingStatus('r1', 'bad')
    expect(result.success).toBe(false)
    expect(result.error).toBe('invalid status')
  })

  // -------------------------------------------------------------------------
  // INLINE: updateTranscriptionStatus
  // -------------------------------------------------------------------------

  it('updateTranscriptionStatus 2xx → {success:true,data}', async () => {
    http.patch.mockResolvedValueOnce(ok2xx({ ok: true }))
    const result = await grp.updateTranscriptionStatus('r1', 'completed')
    expect(result.success).toBe(true)
  })

  it('updateTranscriptionStatus 4xx → {success:false,error}', async () => {
    http.patch.mockResolvedValueOnce(err4xx(400, 'bad status'))
    const result = await grp.updateTranscriptionStatus('r1', 'bad')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  // -------------------------------------------------------------------------
  // BOOL: delete
  // -------------------------------------------------------------------------

  it('delete 2xx → true', async () => {
    http.del.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.delete('r1')
    expect(result).toBe(true)
  })

  it('delete 4xx → false', async () => {
    http.del.mockResolvedValueOnce(err4xx())
    const result = await grp.delete('r1')
    expect(result).toBe(false)
  })

  // -------------------------------------------------------------------------
  // INLINE: deleteBatch
  // -------------------------------------------------------------------------

  it('deleteBatch 2xx → {success,deleted,failed,errors}', async () => {
    const body = { success: true, deleted: 2, failed: 0, errors: [] }
    http.post.mockResolvedValueOnce(ok2xx(body))
    const result = await grp.deleteBatch(['r1', 'r2'])
    expect(result.success).toBe(true)
    expect(result.deleted).toBe(2)
    expect(result.failed).toBe(0)
    expect(Array.isArray(result.errors)).toBe(true)
  })

  it('deleteBatch 4xx → {success:false,deleted:0,failed,errors:[]}', async () => {
    http.post.mockResolvedValueOnce(err4xx())
    const result = await grp.deleteBatch(['r1', 'r2'])
    expect(result.success).toBe(false)
    expect(result.deleted).toBe(0)
    expect(result.failed).toBe(2)
    expect(result.errors).toEqual([])
  })

  // -------------------------------------------------------------------------
  // INLINE: getCandidates
  // -------------------------------------------------------------------------

  it('getCandidates 2xx → {success:true,data:[…]}', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ id: 'm1' }]))
    const result = await grp.getCandidates('r1')
    expect(result.success).toBe(true)
    expect(Array.isArray(result.data)).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('getCandidates 4xx → {success:false,data:[],error}', async () => {
    http.get.mockResolvedValueOnce(err4xx(400, 'oops'))
    const result = await grp.getCandidates('r1')
    expect(result.success).toBe(false)
    expect(result.data).toEqual([])
    expect(typeof result.error).toBe('string')
  })

  // -------------------------------------------------------------------------
  // INLINE: getMeetingsNearDate
  // -------------------------------------------------------------------------

  it('getMeetingsNearDate 2xx → {success:true,data:[…]}', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ id: 'm1' }]))
    const result = await grp.getMeetingsNearDate('2026-01-01')
    expect(result.success).toBe(true)
    expect(Array.isArray(result.data)).toBe(true)
  })

  it('getMeetingsNearDate 4xx → {success:false,data:[],error}', async () => {
    http.get.mockResolvedValueOnce(err4xx(500, 'fail'))
    const result = await grp.getMeetingsNearDate('2026-01-01')
    expect(result.success).toBe(false)
    expect(result.data).toEqual([])
  })

  // -------------------------------------------------------------------------
  // INLINE: selectMeeting
  // -------------------------------------------------------------------------

  it('selectMeeting 2xx → {success:true}', async () => {
    http.post.mockResolvedValueOnce(ok2xx({}))
    const result = await grp.selectMeeting('r1', 'm1')
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('selectMeeting 4xx → {success:false,error}', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'not found'))
    const result = await grp.selectMeeting('r1', 'm1')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  // -------------------------------------------------------------------------
  // DROPPED: addExternal
  // -------------------------------------------------------------------------

  it('addExternal always returns {success:false,error} stub', async () => {
    const result = await grp.addExternal()
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  // -------------------------------------------------------------------------
  // INLINE: addExternalByPath — uses http.postForm transport
  // -------------------------------------------------------------------------

  it('addExternalByPath 2xx → {success:true, recording}', async () => {
    const rec = { id: 'r1', filename: 'test.wav' }
    ;(http as any).postForm.mockResolvedValueOnce({ ok: true, status: 200, data: { recording: rec } })
    const result = await grp.addExternalByPath('/some/path/test.wav')
    expect(result.success).toBe(true)
    expect(result.recording).toEqual(rec)
  })

  it('addExternalByPath 4xx → {success:false, error}', async () => {
    ;(http as any).postForm.mockResolvedValueOnce({ ok: false, status: 422, error: 'Upload failed' })
    const result = await grp.addExternalByPath('/some/path/test.wav')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  // -------------------------------------------------------------------------
  // STRING|FALSE: transcribe
  // -------------------------------------------------------------------------

  it('transcribe 2xx → id string', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ id: 'qi-123' }))
    const result = await grp.transcribe('r1')
    expect(result).toBe('qi-123')
  })

  it('transcribe 4xx → false', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'cannot transcribe'))
    const result = await grp.transcribe('r1')
    expect(result).toBe(false)
  })

  // -------------------------------------------------------------------------
  // STRING|FALSE: addToQueue
  // -------------------------------------------------------------------------

  it('addToQueue 2xx → id string', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ queueItemId: 'qi-456' }))
    const result = await grp.addToQueue('r1')
    expect(result).toBe('qi-456')
  })

  it('addToQueue 4xx → false', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'error'))
    const result = await grp.addToQueue('r1')
    expect(result).toBe(false)
  })

  it('transcribe 2xx unexpected body shape (no id/queueItemId) → false', async () => {
    // Server returns a different shape — id extraction fails silently but with a warning
    http.post.mockResolvedValueOnce(ok2xx({ queueId: 'qi-999' }))
    const result = await grp.transcribe('r1')
    expect(result).toBe(false)
  })

  it('addToQueue 2xx unexpected body shape → false', async () => {
    http.post.mockResolvedValueOnce(ok2xx('bare-string-body'))
    const result = await grp.addToQueue('r1')
    expect(result).toBe(false)
  })

  // -------------------------------------------------------------------------
  // BOOL: processQueue
  // -------------------------------------------------------------------------

  it('processQueue 2xx → true', async () => {
    http.post.mockResolvedValueOnce(ok2xx({}))
    expect(await grp.processQueue()).toBe(true)
  })

  it('processQueue 4xx → false', async () => {
    http.post.mockResolvedValueOnce(err4xx())
    expect(await grp.processQueue()).toBe(false)
  })

  // -------------------------------------------------------------------------
  // INLINE: getTranscriptionStatus
  // -------------------------------------------------------------------------

  it('getTranscriptionStatus 2xx → {isProcessing,pendingCount,processingCount}', async () => {
    http.get.mockResolvedValueOnce(
      ok2xx({ isProcessing: true, pendingCount: 3, processingCount: 1 }),
    )
    const result = await grp.getTranscriptionStatus()
    expect(result.isProcessing).toBe(true)
    expect(result.pendingCount).toBe(3)
    expect(result.processingCount).toBe(1)
  })

  it('getTranscriptionStatus 4xx → safe defaults', async () => {
    http.get.mockResolvedValueOnce(err4xx())
    const result = await grp.getTranscriptionStatus()
    expect(result.isProcessing).toBe(false)
    expect(result.pendingCount).toBe(0)
  })

  // -------------------------------------------------------------------------
  // RAW-THROW: getTranscriptionQueue
  // -------------------------------------------------------------------------

  it('getTranscriptionQueue 2xx → bare any[]', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ id: 'qi-1' }]))
    const result = await grp.getTranscriptionQueue()
    expect(Array.isArray(result)).toBe(true)
  })

  it('getTranscriptionQueue 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx())
    await expect(grp.getTranscriptionQueue()).rejects.toThrow()
  })

  // -------------------------------------------------------------------------
  // INLINE: cancelTranscription
  // -------------------------------------------------------------------------

  it('cancelTranscription 2xx → {success:true}', async () => {
    http.post.mockResolvedValueOnce(ok2xx({}))
    const result = await grp.cancelTranscription('r1')
    expect(result.success).toBe(true)
  })

  it('cancelTranscription 4xx → {success:false}', async () => {
    http.post.mockResolvedValueOnce(err4xx())
    const result = await grp.cancelTranscription('r1')
    expect(result.success).toBe(false)
  })

  // -------------------------------------------------------------------------
  // INLINE: cancelAllTranscriptions
  // -------------------------------------------------------------------------

  it('cancelAllTranscriptions 2xx → {success,count}', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ success: true, count: 5 }))
    const result = await grp.cancelAllTranscriptions()
    expect(result.success).toBe(true)
    expect(result.count).toBe(5)
  })

  it('cancelAllTranscriptions 4xx → {success:false,count:0}', async () => {
    http.post.mockResolvedValueOnce(err4xx())
    const result = await grp.cancelAllTranscriptions()
    expect(result.success).toBe(false)
    expect(result.count).toBe(0)
  })

  // -------------------------------------------------------------------------
  // BOOL: updateQueueItem
  // -------------------------------------------------------------------------

  it('updateQueueItem 2xx → true', async () => {
    http.patch.mockResolvedValueOnce(ok2xx({}))
    expect(await grp.updateQueueItem('qi-1', 'completed')).toBe(true)
  })

  it('updateQueueItem 4xx → false', async () => {
    http.patch.mockResolvedValueOnce(err4xx())
    expect(await grp.updateQueueItem('qi-1', 'failed', 'error msg')).toBe(false)
  })

  // -------------------------------------------------------------------------
  // INLINE: validateTranscriptionConfig
  // -------------------------------------------------------------------------

  it('validateTranscriptionConfig 2xx → {ok,problems}', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ ok: true, problems: [] }))
    const result = await grp.validateTranscriptionConfig()
    expect(result.ok).toBe(true)
    expect(Array.isArray(result.problems)).toBe(true)
  })

  it('validateTranscriptionConfig 4xx → {ok:false,problems:[]}', async () => {
    http.get.mockResolvedValueOnce(err4xx())
    const result = await grp.validateTranscriptionConfig()
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([])
  })

  // -------------------------------------------------------------------------
  // INLINE: resummarize
  // -------------------------------------------------------------------------

  it('resummarize 2xx → {success:true}', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ success: true }))
    const result = await grp.resummarize('r1')
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('resummarize 4xx → {success:false,error}', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'template missing'))
    const result = await grp.resummarize('r1')
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  // -------------------------------------------------------------------------
  // BOOL: isSummaryStale
  // -------------------------------------------------------------------------

  it('isSummaryStale 2xx {stale:true} → true', async () => {
    http.get.mockResolvedValueOnce(ok2xx({ stale: true }))
    expect(await grp.isSummaryStale('r1')).toBe(true)
  })

  it('isSummaryStale 4xx → false', async () => {
    http.get.mockResolvedValueOnce(err4xx())
    expect(await grp.isSummaryStale('r1')).toBe(false)
  })

  // -------------------------------------------------------------------------
  // INLINE: retryAllFailed
  // -------------------------------------------------------------------------

  it('retryAllFailed 2xx → {success,count}', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ success: true, count: 3 }))
    const result = await grp.retryAllFailed()
    expect(result.success).toBe(true)
    expect(result.count).toBe(3)
  })

  it('retryAllFailed 4xx → {success:false,count:0}', async () => {
    http.post.mockResolvedValueOnce(err4xx())
    const result = await grp.retryAllFailed()
    expect(result.success).toBe(false)
    expect(result.count).toBe(0)
  })

  // -------------------------------------------------------------------------
  // RAW-THROW: linkToMeeting
  // -------------------------------------------------------------------------

  it('linkToMeeting 2xx → bare data', async () => {
    http.post.mockResolvedValueOnce(ok2xx({ linked: true }))
    const result = await grp.linkToMeeting('r1', 'm1', 0.95, 'manual')
    expect(result).toEqual({ linked: true })
  })

  it('linkToMeeting 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx(400, 'bad'))
    await expect(grp.linkToMeeting('r1', 'm1', 0.5, 'manual')).rejects.toThrow()
  })
})
