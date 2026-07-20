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

  it('retries the whole file on a finalize integrity mismatch', async () => {
    const postStream = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: { uploadId: 'u3', serverSha256: 'x', bytesReceived: 3 },
    })
    const post = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, error: 'integrity check failed' })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { recordingId: 'r1', status: 'synced' } })
    const http = { postStream, post } as any
    const client = makeDeviceSyncClient({ http })
    const res = await client.syncFile(srcOf([1, 2, 3]))
    expect(res.status).toBe('synced')
    expect(postStream).toHaveBeenCalledTimes(2)
  })

  it('trims trailing overshoot so exactly `size` bytes are uploaded (device pads the final packet)', async () => {
    let capturedBlob: Blob | undefined
    const postStream = vi.fn().mockImplementation((_path: string, blob: Blob) => {
      capturedBlob = blob
      return Promise.resolve({ ok: true, status: 200, data: { uploadId: 'u1', serverSha256: 'x', bytesReceived: 5 } })
    })
    const http = {
      postStream,
      post: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { recordingId: 'r1', status: 'synced' } }),
    } as any
    const client = makeDeviceSyncClient({ http })
    // Declared size 5, but the device streams 8 bytes (final packet padded past EOF).
    const src = { filename: 'REC_OVER.hda', size: 5, async *stream() { yield new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) } }
    const res = await client.syncFile(src)
    expect(res.status).toBe('synced')
    expect(capturedBlob).toBeDefined()
    // Only the real file bytes are uploaded — the 3 trailing padding bytes are dropped.
    expect(capturedBlob!.size).toBe(5)
  })

  it('does NOT upload a short/empty read (transferIn cancelled mid-download) — retries then throws', async () => {
    const postStream = vi.fn()
    const post = vi.fn()
    const http = { postStream, post } as any
    const client = makeDeviceSyncClient({ http })
    // Declared size 8, but the device delivered nothing (downloadFile cross-resolved to a fake
    // success and streamed 0 chunks) — the exact bytes=0 production symptom.
    const src = { filename: 'REC_EMPTY.hda', size: 8, async *stream() { /* yields nothing */ } }
    await expect(client.syncFile(src)).rejects.toThrow(/short read/i)
    expect(postStream).not.toHaveBeenCalled() // never uploads the empty/short body
    expect(post).not.toHaveBeenCalled() // never finalizes
  })

  it('does NOT upload a partial read (fewer bytes than declared) — retries then throws', async () => {
    const postStream = vi.fn()
    const post = vi.fn()
    const http = { postStream, post } as any
    const client = makeDeviceSyncClient({ http })
    // Declared size 8, device delivered only 3 bytes.
    const src = { filename: 'REC_SHORT.hda', size: 8, async *stream() { yield new Uint8Array([1, 2, 3]) } }
    await expect(client.syncFile(src)).rejects.toThrow(/short read: got 3 of 8/i)
    expect(postStream).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('rejects a source with zero/unknown size instead of uploading a bogus file', async () => {
    const http = { postStream: vi.fn(), post: vi.fn() } as any
    const client = makeDeviceSyncClient({ http })
    const src = { filename: 'REC0.hda', size: 0, async *stream() { yield new Uint8Array([1, 2, 3]) } }
    await expect(client.syncFile(src)).rejects.toThrow(/size/i)
    expect(http.postStream).not.toHaveBeenCalled()
  })

  it('throws after MAX_ATTEMPTS failed creates without exceeding the attempt bound', async () => {
    const postStream = vi.fn().mockResolvedValue({ ok: false, status: 0, error: 'network' })
    const http = {
      postStream,
      post: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { recordingId: 'r', status: 'synced' } }),
    } as any
    const client = makeDeviceSyncClient({ http })
    await expect(client.syncFile(srcOf([1, 2, 3]))).rejects.toThrow()
    expect(postStream).toHaveBeenCalledTimes(2)
  })
})
