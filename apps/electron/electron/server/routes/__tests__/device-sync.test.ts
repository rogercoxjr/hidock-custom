// electron/server/routes/__tests__/device-sync.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const insertRecording = vi.fn()
const addToQueue = vi.fn()
const isFileAlreadySynced = vi.fn()
const saveRecordingFromPath = vi.fn()
const broadcast = vi.fn()
const processQueueManually = vi.fn().mockResolvedValue(undefined)

// Mock every main-process dependency the route touches EXCEPT partfile-store —
// partfile-store (Task 4) does real disk I/O against HIDOCK_DATA_ROOT, which we
// point at a temp dir per test so the route's streaming/hashing runs for real.
vi.mock('../../../main/services/database', () => ({
  insertRecording: (...args: unknown[]) => insertRecording(...args),
  addToQueue: (...args: unknown[]) => addToQueue(...args)
}))
vi.mock('../../../main/services/file-storage', () => ({
  saveRecordingFromPath: (...args: unknown[]) => saveRecordingFromPath(...args)
}))
vi.mock('../../../main/services/sync-reconcile', () => ({
  isFileAlreadySynced: (...args: unknown[]) => isFileAlreadySynced(...args)
}))
vi.mock('../../../main/services/broadcaster', () => ({
  getBroadcaster: () => ({ broadcast })
}))
// Fire-and-forget import in the finalize handler — stub so it never touches the
// real (unmocked) transcription pipeline / its own database imports.
vi.mock('../../../main/services/transcription', () => ({
  processQueueManually: (...args: unknown[]) => processQueueManually(...args)
}))

import { registerDeviceSync } from '../device-sync'

function appWithAuth() {
  const app = Fastify()
  app.decorate('requireAuth', async () => {})
  app.decorate('requireSameOrigin', async () => {})
  return app
}

describe('device-sync routes', () => {
  let dir: string

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    dir = mkdtempSync(join(tmpdir(), 'hidock-device-sync-'))
    process.env.HIDOCK_DATA_ROOT = dir
    isFileAlreadySynced.mockReturnValue({ synced: false, reason: 'not found' })
    saveRecordingFromPath.mockImplementation((filename: string) => join(dir, 'recordings', filename))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.HIDOCK_DATA_ROOT
  })

  it('stream → finalize with matching hash → synced', async () => {
    const app = appWithAuth()
    await registerDeviceSync(app)
    const meta = Buffer.from(JSON.stringify({ filename: 'REC1.hda', size: 3 })).toString('base64')
    const create = await app.inject({
      method: 'POST',
      url: '/api/recordings/sync',
      headers: { 'x-device-file': meta, 'content-type': 'application/octet-stream' },
      payload: Buffer.from([1, 2, 3])
    })
    expect(create.statusCode).toBe(200)
    const { uploadId, serverSha256 } = create.json()
    const fin = await app.inject({
      method: 'POST',
      url: `/api/recordings/sync/${uploadId}/finalize`,
      payload: { clientSha256: serverSha256 }
    })
    expect(fin.statusCode).toBe(200)
    expect(fin.json().status).toMatch(/synced|skipped/)
    expect(insertRecording).toHaveBeenCalledTimes(1)
    expect(addToQueue).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith('recording:new', expect.objectContaining({ id: expect.any(String) }))
  })

  it('finalize with wrong hash → 4xx', async () => {
    const app = appWithAuth()
    await registerDeviceSync(app)
    const meta = Buffer.from(JSON.stringify({ filename: 'REC2.hda', size: 3 })).toString('base64')
    const create = await app.inject({
      method: 'POST',
      url: '/api/recordings/sync',
      headers: { 'x-device-file': meta },
      payload: Buffer.from([1, 2, 3])
    })
    const { uploadId } = create.json()
    const fin = await app.inject({
      method: 'POST',
      url: `/api/recordings/sync/${uploadId}/finalize`,
      payload: { clientSha256: 'deadbeef' }
    })
    expect(fin.statusCode).toBe(400)
    expect(insertRecording).not.toHaveBeenCalled()
  })

  it('skips ingest when already synced (reconciled)', async () => {
    isFileAlreadySynced.mockReturnValue({ synced: true, reason: 'In synced_files table' })
    const app = appWithAuth()
    await registerDeviceSync(app)
    const meta = Buffer.from(JSON.stringify({ filename: 'REC3.hda', size: 3 })).toString('base64')
    const create = await app.inject({
      method: 'POST',
      url: '/api/recordings/sync',
      headers: { 'x-device-file': meta },
      payload: Buffer.from([1, 2, 3])
    })
    const { uploadId, serverSha256 } = create.json()
    const fin = await app.inject({
      method: 'POST',
      url: `/api/recordings/sync/${uploadId}/finalize`,
      payload: { clientSha256: serverSha256 }
    })
    expect(fin.statusCode).toBe(200)
    expect(fin.json()).toEqual({ recordingId: '', status: 'skipped' })
    expect(insertRecording).not.toHaveBeenCalled()
  })

  it('DELETE cleans up an abandoned upload', async () => {
    const app = appWithAuth()
    await registerDeviceSync(app)
    const meta = Buffer.from(JSON.stringify({ filename: 'REC4.hda', size: 3 })).toString('base64')
    const create = await app.inject({
      method: 'POST',
      url: '/api/recordings/sync',
      headers: { 'x-device-file': meta },
      payload: Buffer.from([1, 2, 3])
    })
    const { uploadId } = create.json()
    const del = await app.inject({ method: 'DELETE', url: `/api/recordings/sync/${uploadId}` })
    expect(del.statusCode).toBe(204)

    // Finalizing after delete → the in-memory record is gone → 404.
    const fin = await app.inject({
      method: 'POST',
      url: `/api/recordings/sync/${uploadId}/finalize`,
      payload: { clientSha256: 'whatever' }
    })
    expect(fin.statusCode).toBe(404)
  })
})
