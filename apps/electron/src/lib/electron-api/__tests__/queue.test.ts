/**
 * queue.test.ts — Shape-assertion tests for the queue SDK group.
 *
 * queue.getItems — RAW-THROW; bare any[] on 2xx; throw on error.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeQueueGroup } from '../groups/queue'
import type { Http } from '../http'

function makeHttp() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
  } as unknown as Http & { get: ReturnType<typeof vi.fn> }
}

describe('makeQueueGroup', () => {
  let http: ReturnType<typeof makeHttp>
  let grp: ReturnType<typeof makeQueueGroup>

  beforeEach(() => {
    http = makeHttp()
    grp = makeQueueGroup({ http })
  })

  it('getItems 2xx (no status) → bare any[]', async () => {
    http.get.mockResolvedValueOnce({ ok: true, status: 200, data: [{ id: 'qi-1' }] })
    const result = await grp.getItems()
    expect(Array.isArray(result)).toBe(true)
    expect(result[0]).toEqual({ id: 'qi-1' })
    // No status param → path ends without ?status= query
    expect((http.get as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/api/queue')
  })

  it('getItems 2xx (with status) → bare any[]', async () => {
    http.get.mockResolvedValueOnce({ ok: true, status: 200, data: [{ id: 'qi-2' }] })
    const result = await grp.getItems('pending')
    expect(Array.isArray(result)).toBe(true)
    // Status param is appended
    expect((http.get as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/status=pending/)
  })

  it('getItems 4xx → throws', async () => {
    http.get.mockResolvedValueOnce({ ok: false, status: 500, error: 'Server Error' })
    await expect(grp.getItems()).rejects.toThrow('Server Error')
  })
})
