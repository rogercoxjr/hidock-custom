// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs'
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

/**
 * Build a minimal multipart/form-data body with a single file field "file".
 * We construct the boundary manually to avoid requiring the `form-data` package
 * as a declared dep — the bytes are simple enough to hand-roll.
 */
function buildMultipartBody(
  filename: string,
  fileBytes: Buffer,
  boundary = 'testboundary123'
): { body: Buffer; contentType: string } {
  const CRLF = '\r\n'
  const header =
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
    `Content-Type: application/octet-stream${CRLF}` +
    CRLF
  const footer = `${CRLF}--${boundary}--${CRLF}`

  const body = Buffer.concat([Buffer.from(header, 'utf-8'), fileBytes, Buffer.from(footer, 'utf-8')])
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

describe('POST /api/recordings/upload', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-upload-'))
    process.env.HIDOCK_DATA_ROOT = dir

    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin } = await import('../../main/services/database')
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')
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

  it('returns 401 when not authenticated', async () => {
    const app = await makeApp()
    const fakeWav = Buffer.from('RIFF....WAVEfmt ', 'utf-8')
    const { body, contentType } = buildMultipartBody('test.wav', fakeWav)
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/upload',
      headers: { 'content-type': contentType },
      payload: body
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('returns 400 for a non-audio file extension (.txt)', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const { body, contentType } = buildMultipartBody('notes.txt', Buffer.from('hello world'))
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/upload',
      headers: { 'content-type': contentType, 'origin': 'https://hub.example.com' },
      cookies: { hidock_session: cookie },
      payload: body
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('uploads a .wav file → 201 + recording row exists + file persisted on disk', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Minimal valid-ish WAV header bytes (content doesn't need to be decodable)
    const fakeWavBytes = Buffer.alloc(64, 0)
    fakeWavBytes.write('RIFF', 0)
    fakeWavBytes.write('WAVE', 8)

    const { body, contentType } = buildMultipartBody('meeting-2024.wav', fakeWavBytes)

    const { getRecordingsPath } = await import('../../main/services/file-storage')
    const { getRecordings: dbGetRecordings } = await import('../../main/services/database')
    const recordingsBefore = dbGetRecordings().length

    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/upload',
      headers: { 'content-type': contentType, 'origin': 'https://hub.example.com' },
      cookies: { hidock_session: cookie },
      payload: body
    })

    expect(res.statusCode).toBe(201)
    const json = res.json()
    expect(json).toHaveProperty('recording')
    expect(json.recording).toHaveProperty('id')
    expect(json.recording.status).toBe('ready')
    expect(json.recording.location).toBe('local-only')
    expect(json.recording.transcription_status).toBe('none')
    expect(json.recording.source).toBe('upload')
    expect(json.recording.is_imported).toBe(1)

    // DB row count grew by 1
    const recordingsAfter = dbGetRecordings()
    expect(recordingsAfter.length).toBe(recordingsBefore + 1)

    // File exists on disk under the recordings path
    const recPath = getRecordingsPath()
    const files = readdirSync(recPath)
    expect(files.length).toBeGreaterThan(0)
    const storedFile = files.find((f) => f.endsWith('.wav'))
    expect(storedFile).toBeDefined()
    expect(existsSync(join(recPath, storedFile!))).toBe(true)

    await app.close()
  })

  it('uploads a .mp3 file → 201', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const fakeMp3 = Buffer.from('ID3', 'utf-8')
    const { body, contentType } = buildMultipartBody('podcast.mp3', fakeMp3)
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/upload',
      headers: { 'content-type': contentType, 'origin': 'https://hub.example.com' },
      cookies: { hidock_session: cookie },
      payload: body
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().recording.filename).toContain('.mp3')
    await app.close()
  })

  it('returns 400 for an .exe file extension', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const { body, contentType } = buildMultipartBody('malicious.exe', Buffer.from('MZ'))
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/upload',
      headers: { 'content-type': contentType, 'origin': 'https://hub.example.com' },
      cookies: { hidock_session: cookie },
      payload: body
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})
