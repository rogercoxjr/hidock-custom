import { describe, it, expect, vi } from 'vitest'
import { makeDeviceSyncClient } from '../device-sync-client'

function srcOf(bytes: number[]) {
  return { filename: 'REC1.hda', size: bytes.length, async *stream() { yield new Uint8Array(bytes) } }
}

describe('makeDeviceSyncClient', () => {
  it('streams, sends browser hash on finalize, returns synced', async () => {
    const http = {
      postStream: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        data: { uploadId: 'u1', serverSha256: 'x', bytesReceived: 3 },
      }),
      post: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { recordingId: 'r1', status: 'synced' } }),
    } as any
    const client = makeDeviceSyncClient({ http })
    const res = await client.syncFile(srcOf([1, 2, 3]))
    expect(res.status).toBe('synced')
    expect(http.post.mock.calls[0][0]).toBe('/api/recordings/sync/u1/finalize')
    expect(http.post.mock.calls[0][1]).toHaveProperty('clientSha256')
  })

  it('retries the whole file once on a failed create', async () => {
    const postStream = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 0, error: 'network' })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { uploadId: 'u2', serverSha256: 'x', bytesReceived: 3 } })
    const http = {
      postStream,
      post: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { recordingId: 'r', status: 'synced' } }),
    } as any
    const client = makeDeviceSyncClient({ http })
    const res = await client.syncFile(srcOf([1, 2, 3]))
    expect(res.status).toBe('synced')
    expect(postStream).toHaveBeenCalledTimes(2)
  })
})
