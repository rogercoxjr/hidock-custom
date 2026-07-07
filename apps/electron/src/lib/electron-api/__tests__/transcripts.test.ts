/**
 * transcripts.test.ts — Shape-assertion tests for the transcripts SDK group.
 *
 * Each test feeds a 2xx or 4xx mock and asserts the returned shape matches
 * CONTRACTS.md exactly.
 *
 * transcripts.export: call site reads res.error.message — verify error is
 * synthesized as { message, details? }.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeTranscriptsGroup } from '../groups/transcripts'
import type { Http } from '../http'

function makeHttp() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
  } as unknown as Http & {
    get: ReturnType<typeof vi.fn>
    post: ReturnType<typeof vi.fn>
    patch: ReturnType<typeof vi.fn>
    put: ReturnType<typeof vi.fn>
    del: ReturnType<typeof vi.fn>
  }
}

function ok2xx(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, data })
}

function err4xx(status = 400, error = 'Bad Request', data?: unknown) {
  return Promise.resolve({ ok: false, status, error, data })
}

describe('makeTranscriptsGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeTranscriptsGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeTranscriptsGroup({ http })
  })

  // -------------------------------------------------------------------------
  // RAW-THROW: getByRecordingId
  // -------------------------------------------------------------------------

  it('getByRecordingId 2xx → bare row', async () => {
    const row = { id: 't1', recordingId: 'r1', text: 'hello' }
    http.get.mockResolvedValueOnce(ok2xx(row))
    const result = await grp.getByRecordingId('r1')
    expect(result).toEqual(row)
  })

  it('getByRecordingId 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx(404, 'Not Found'))
    await expect(grp.getByRecordingId('missing')).rejects.toThrow('Not Found')
  })

  // -------------------------------------------------------------------------
  // RAW-THROW: getByRecordingIds
  // -------------------------------------------------------------------------

  it('getByRecordingIds 2xx → bare Record', async () => {
    const body = { r1: { id: 't1' }, r2: { id: 't2' } }
    http.post.mockResolvedValueOnce(ok2xx(body))
    const result = await grp.getByRecordingIds(['r1', 'r2'])
    expect(result).toEqual(body)
  })

  // Contract: the server route (POST /api/transcripts/by-recording-ids) parses
  // `{ ids }` via zod — sending any other key 400s and the transcript never
  // loads in the Library. Pin the request body key to the route's contract.
  it('getByRecordingIds POSTs the { ids } body the route expects', async () => {
    http.post.mockResolvedValueOnce(ok2xx({}))
    await grp.getByRecordingIds(['r1', 'r2'])
    expect(http.post).toHaveBeenCalledWith('/api/transcripts/by-recording-ids', { ids: ['r1', 'r2'] })
  })

  it('getByRecordingIds 4xx → throws', async () => {
    http.post.mockResolvedValueOnce(err4xx())
    await expect(grp.getByRecordingIds(['r1'])).rejects.toThrow()
  })

  // -------------------------------------------------------------------------
  // RAW-THROW: search
  // -------------------------------------------------------------------------

  it('search 2xx → bare any[]', async () => {
    http.get.mockResolvedValueOnce(ok2xx([{ id: 't1' }]))
    const result = await grp.search('hello')
    expect(Array.isArray(result)).toBe(true)
  })

  it('search 4xx → throws', async () => {
    http.get.mockResolvedValueOnce(err4xx())
    await expect(grp.search('hello')).rejects.toThrow()
  })

  // -------------------------------------------------------------------------
  // RESULT: updateTurns
  // -------------------------------------------------------------------------

  it('updateTurns 2xx → {success:true,data:{recordingId}}', async () => {
    http.patch.mockResolvedValueOnce(ok2xx({ recordingId: 'r1' }))
    const result = await grp.updateTurns({ recordingId: 'r1', turns: [] })
    expect(result.success).toBe(true)
    expect((result as any).data).toEqual({ recordingId: 'r1' })
  })

  it('updateTurns 4xx → {success:false,error:{message}} (error is object per CONTRACTS §error-detail)', async () => {
    http.patch.mockResolvedValueOnce(err4xx(400, 'validation error'))
    const result = await grp.updateTurns({ recordingId: 'r1', turns: [] })
    expect(result.success).toBe(false)
    // Must match export() pattern — error is an object with .message, not a bare string
    expect(typeof (result as any).error?.message).toBe('string')
    expect((result as any).error.message).toBe('validation error')
  })

  // -------------------------------------------------------------------------
  // RESULT: export — error.message synthesized as object
  // -------------------------------------------------------------------------

  it('export 2xx → {success:true,data:string}', async () => {
    http.post.mockResolvedValueOnce(ok2xx('timestamp,speaker,text\n1,A,Hello'))
    const result = await grp.export('r1', 'csv')
    expect(result.success).toBe(true)
    expect(typeof (result as any).data).toBe('string')
  })

  it('export 2xx null body → {success:true,data:null}', async () => {
    http.post.mockResolvedValueOnce(ok2xx(null))
    const result = await grp.export('r1', 'csv')
    expect(result.success).toBe(true)
    expect((result as any).data).toBeNull()
  })

  it('export 4xx → {success:false,error.message} (error is object with .message)', async () => {
    http.post.mockResolvedValueOnce(err4xx(500, 'export failed'))
    const result = await grp.export('r1', 'csv')
    expect(result.success).toBe(false)
    // Call site reads res.error.message — must be an object, not a bare string
    const err = (result as any).error
    expect(typeof err).toBe('object')
    expect(typeof err.message).toBe('string')
    expect(err.message).toBe('export failed')
  })

  it('export 4xx with details → error.details surfaced', async () => {
    const details = { fieldErrors: { format: ['unsupported'] } }
    http.post.mockResolvedValueOnce(
      err4xx(400, 'format error', { error: 'format error', details }),
    )
    const result = await grp.export('r1', 'csv')
    expect(result.success).toBe(false)
    const err = (result as any).error
    expect(err.message).toBe('format error')
    expect(err.details).toEqual(details)
  })
})
