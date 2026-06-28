import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildApp } from '../app'
import { createFakeOidc } from '../oidc'
import { testDeps } from './app.test'

async function makeApp() {
  return buildApp(
    testDeps({ oidc: createFakeOidc({ email: 'boss@x.com', emailVerified: true, sub: 'sub-boss' }) })
  )
}

async function login(app: Awaited<ReturnType<typeof buildApp>>) {
  const start = await app.inject({ method: 'GET', url: '/auth/login' })
  const startCookie = start.cookies.find((c) => c.name === 'hidock_session')!
  const cb = await app.inject({
    method: 'GET',
    url: '/auth/callback?code=x&state=ignored-by-fake',
    cookies: { hidock_session: startCookie.value }
  })
  const cbCookie = cb.cookies.find((c) => c.name === 'hidock_session')
  return (cbCookie ?? startCookie).value
}

/** Write a small deterministic binary file so we can verify byte ranges. */
function writeTestAudio(dir: string, filename: string): { filePath: string; content: Buffer } {
  const recordingsDir = join(dir, 'recordings')
  if (!require('fs').existsSync(recordingsDir)) {
    mkdirSync(recordingsDir, { recursive: true })
  }
  // 100 bytes: 0x00, 0x01, 0x02, … 0x63
  const content = Buffer.from(Array.from({ length: 100 }, (_, i) => i))
  const filePath = join(recordingsDir, filename)
  writeFileSync(filePath, content)
  return { filePath, content }
}

describe('media endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-media-'))
    process.env.HIDOCK_DATA_ROOT = dir

    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, insertRecording } = await import(
      '../../main/services/database'
    )
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')

    // rec-with-file: has a real file on disk
    const { filePath } = writeTestAudio(dir, 'test.wav')
    insertRecording({
      id: 'rec-with-file',
      filename: 'test.wav',
      file_path: filePath,
      date_recorded: '2024-01-01T10:00:00Z',
      status: 'ready',
      location: 'local-only',
      transcription_status: 'none',
      on_device: 0,
      on_local: 1,
      source: 'hidock',
      is_imported: 0
    })

    // rec-no-file: file_path is null
    insertRecording({
      id: 'rec-no-file',
      filename: 'ghost.wav',
      file_path: null,
      date_recorded: '2024-01-02T10:00:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'none',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0
    })
  })

  afterEach(async () => {
    const { closeDatabase } = await import('../../main/services/database')
    try {
      closeDatabase()
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true })
    delete process.env.HIDOCK_DATA_ROOT
  })

  it('GET /api/recordings/:id/media without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/recordings/rec-with-file/media' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/recordings/unknown/media returns 404', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/does-not-exist/media',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('returns 404 when recording has no file_path', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-no-file/media',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('returns 200 with full file content and correct headers (no Range)', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-with-file/media',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/audio\/wav/)
    expect(res.headers['accept-ranges']).toBe('bytes')
    expect(Number(res.headers['content-length'])).toBe(100)
    // Verify all 100 bytes are present
    expect(res.rawPayload.length).toBe(100)
    expect(res.rawPayload[0]).toBe(0)
    expect(res.rawPayload[99]).toBe(99)
    await app.close()
  })

  it('returns 206 with correct byte slice for a Range request', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    // Request bytes 10–19 (10 bytes)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-with-file/media',
      headers: { range: 'bytes=10-19' },
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(206)
    expect(res.headers['content-range']).toBe('bytes 10-19/100')
    expect(Number(res.headers['content-length'])).toBe(10)
    expect(res.rawPayload.length).toBe(10)
    // Bytes 10..19 should be 0x0a..0x13
    for (let i = 0; i < 10; i++) {
      expect(res.rawPayload[i]).toBe(10 + i)
    }
    await app.close()
  })

  it('returns 206 for an open-ended range (bytes=50-)', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-with-file/media',
      headers: { range: 'bytes=50-' },
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(206)
    expect(res.headers['content-range']).toBe('bytes 50-99/100')
    expect(res.rawPayload.length).toBe(50)
    expect(res.rawPayload[0]).toBe(50)
    await app.close()
  })

  it('returns 416 for a Range start beyond file size', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-with-file/media',
      headers: { range: 'bytes=200-299' },
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(416)
    expect(res.headers['content-range']).toBe('bytes */100')
    await app.close()
  })

  it('returns 403 for a recording whose file_path is outside the allowed directory', async () => {
    const { insertRecording } = await import('../../main/services/database')
    // Write a file outside the HIDOCK_DATA_ROOT tree so the path exists on disk
    // but fails the isRecordingPathAllowed() guard.
    const secretPath = join(tmpdir(), `hidock-secret-${Date.now()}.txt`)
    writeFileSync(secretPath, 'should not be served')
    insertRecording({
      id: 'rec-hostile-path',
      filename: 'secret.txt',
      file_path: secretPath,
      date_recorded: '2024-01-03T10:00:00Z',
      status: 'ready',
      location: 'local-only',
      transcription_status: 'none',
      on_device: 0,
      on_local: 1,
      source: 'hidock',
      is_imported: 0
    })
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-hostile-path/media',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(403)
    // Ensure the file contents were NOT streamed
    expect(res.body).not.toContain('should not be served')
    // Cleanup the temp file
    try { require('fs').unlinkSync(secretPath) } catch { /* ignore */ }
    await app.close()
  })

  it('returns 206 with correct byte slice for a suffix range (bytes=-N)', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    // bytes=-50 should return the last 50 bytes (bytes 50–99)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-with-file/media',
      headers: { range: 'bytes=-50' },
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(206)
    expect(res.headers['content-range']).toBe('bytes 50-99/100')
    expect(Number(res.headers['content-length'])).toBe(50)
    expect(res.rawPayload.length).toBe(50)
    // First byte of the slice should be 50
    expect(res.rawPayload[0]).toBe(50)
    // Last byte of the slice should be 99
    expect(res.rawPayload[49]).toBe(99)
    await app.close()
  })

  it('returns 200 for a syntactically invalid Range header', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-with-file/media',
      headers: { range: 'bytes=garbage' },
      cookies: { hidock_session: cookie }
    })
    // RFC 7233: server may ignore an unparseable Range and return 200
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.length).toBe(100)
    await app.close()
  })
})
