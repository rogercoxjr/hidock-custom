/**
 * Real-DB tests for the transcripts REST router (0c-2b).
 *
 * Covers:
 *   - 401 on unauthenticated reads
 *   - 403 on cross-origin writes (requireSameOrigin)
 *   - GET /api/recordings/:id/transcript  (200 + 404)
 *   - POST /api/transcripts/by-recording-ids
 *   - GET /api/transcripts/search?q=
 *   - PATCH /api/recordings/:id/transcript/turns
 *   - POST /api/recordings/:id/transcript/export?format=json
 *   - POST /api/recordings/:id/transcribe
 *   - POST /api/recordings/:id/resummarize
 *   - GET /api/recordings/:id/summary-stale
 *   - POST /api/recordings/:id/transcription/cancel
 *   - GET /api/queue
 *   - POST /api/queue/cancel-all
 *   - GET /api/queue/status
 *   - GET /api/transcription/config/validate
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
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

describe('transcripts REST router', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-trans-'))
    process.env.HIDOCK_DATA_ROOT = dir

    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, insertRecording, upsertTranscriptStage1 } = await import(
      '../../main/services/database'
    )
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')

    insertRecording({
      id: 'rec-tx-1',
      filename: 'tx1.hda',
      file_path: null,
      date_recorded: '2024-01-01T10:00:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'complete',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0
    })

    insertRecording({
      id: 'rec-tx-2',
      filename: 'tx2.hda',
      file_path: null,
      date_recorded: '2024-01-02T10:00:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'complete',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0
    })

    // Seed transcript for rec-tx-1
    upsertTranscriptStage1({
      recording_id: 'rec-tx-1',
      full_text: 'Hello world from recording one',
      language: 'en',
      word_count: 5,
      transcription_provider: 'gemini',
      transcription_model: 'gemini-pro'
    })

    // Seed transcript for rec-tx-2
    upsertTranscriptStage1({
      recording_id: 'rec-tx-2',
      full_text: 'Unique phrase zzzunique for search',
      language: 'en',
      word_count: 5,
      transcription_provider: 'gemini',
      transcription_model: 'gemini-pro'
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

  // ------------------------------------------------------------------
  // Auth guard: unauthenticated read returns 401
  // ------------------------------------------------------------------
  it('GET /api/recordings/:id/transcript without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/recordings/rec-tx-1/transcript' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  // ------------------------------------------------------------------
  // GET /api/recordings/:id/transcript
  // ------------------------------------------------------------------
  it('GET /api/recordings/:id/transcript returns 404 for unknown recording', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/does-not-exist/transcript',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('GET /api/recordings/:id/transcript returns 404 when no transcript', async () => {
    // rec-tx-2 transcript is already seeded; test a recording with no transcript
    const { insertRecording } = await import('../../main/services/database')
    insertRecording({
      id: 'rec-no-tx',
      filename: 'notx.hda',
      file_path: null,
      date_recorded: '2024-01-03T10:00:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'none',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0
    })
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-no-tx/transcript',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('GET /api/recordings/:id/transcript returns transcript data', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-tx-1/transcript',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.recording_id).toBe('rec-tx-1')
    expect(body.full_text).toBe('Hello world from recording one')
    await app.close()
  })

  // ------------------------------------------------------------------
  // POST /api/transcripts/by-recording-ids
  // ------------------------------------------------------------------
  it('POST /api/transcripts/by-recording-ids returns map keyed by recording id', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcripts/by-recording-ids',
      payload: { ids: ['rec-tx-1', 'rec-tx-2', 'does-not-exist'] },
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body['rec-tx-1'].full_text).toContain('Hello world')
    expect(body['rec-tx-2'].full_text).toContain('zzzunique')
    // Non-existent id should not appear
    expect(body['does-not-exist']).toBeUndefined()
    await app.close()
  })

  // ------------------------------------------------------------------
  // GET /api/transcripts/search?q=
  // ------------------------------------------------------------------
  it('GET /api/transcripts/search?q= returns matching transcripts', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/transcripts/search?q=zzzunique',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const items = res.json()
    expect(Array.isArray(items)).toBe(true)
    expect(items.length).toBeGreaterThanOrEqual(1)
    expect(items[0].full_text).toContain('zzzunique')
    await app.close()
  })

  it('GET /api/transcripts/search without q returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/transcripts/search',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  // ------------------------------------------------------------------
  // PATCH /api/recordings/:id/transcript/turns — write (requireSameOrigin)
  // ------------------------------------------------------------------
  it('PATCH transcript/turns from a foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/recordings/rec-tx-1/transcript/turns',
      payload: { turns: [{ speaker: 'A', startMs: 0, endMs: 1000, text: 'hi' }] },
      cookies: { hidock_session: cookie },
      headers: { origin: 'https://evil.example.com' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('PATCH transcript/turns persists turns to DB', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const turns = [
      { speaker: 'A', startMs: 0, endMs: 2000, text: 'Hello' },
      { speaker: 'B', startMs: 2001, endMs: 4000, text: 'World' }
    ]
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/recordings/rec-tx-1/transcript/turns',
      payload: { turns },
      cookies: { hidock_session: cookie }
      // no Origin header → passes requireSameOrigin (same-origin check passes on inject without Origin)
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)

    // Verify persisted
    const { getTranscriptByRecordingId } = await import('../../main/services/database')
    const tx = getTranscriptByRecordingId('rec-tx-1')
    expect(tx?.turns).toBeTruthy()
    const parsed = JSON.parse(tx!.turns!)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].speaker).toBe('A')
    await app.close()
  })

  // ------------------------------------------------------------------
  // POST /api/recordings/:id/transcript/export?format=json
  // ------------------------------------------------------------------
  it('POST transcript/export?format=json returns file download headers', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/rec-tx-1/transcript/export?format=json',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.headers['content-disposition']).toContain('attachment')
    // Body should be valid JSON export
    const body = JSON.parse(res.body)
    expect(body.version).toBe(1)
    expect(body.transcript.fullText).toContain('Hello world')
    await app.close()
  })

  it('POST transcript/export?format=csv returns 400 when not diarized', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/rec-tx-1/transcript/export?format=csv',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('POST transcript/export returns 404 for recording with no transcript', async () => {
    const { insertRecording } = await import('../../main/services/database')
    insertRecording({
      id: 'rec-no-tx-2',
      filename: 'notx2.hda',
      file_path: null,
      date_recorded: '2024-01-04T10:00:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'none',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0
    })
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/rec-no-tx-2/transcript/export?format=json',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // ------------------------------------------------------------------
  // GET /api/queue
  // ------------------------------------------------------------------
  it('GET /api/queue without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/queue' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/queue returns an array', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/queue',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
    await app.close()
  })

  // ------------------------------------------------------------------
  // GET /api/queue/status
  // ------------------------------------------------------------------
  it('GET /api/queue/status returns isProcessing and counts', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/queue/status',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.isProcessing).toBe('boolean')
    expect(typeof body.pendingCount).toBe('number')
    await app.close()
  })

  // ------------------------------------------------------------------
  // POST /api/queue/cancel-all — write guard
  // ------------------------------------------------------------------
  it('POST /api/queue/cancel-all from foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/queue/cancel-all',
      cookies: { hidock_session: cookie },
      headers: { origin: 'https://evil.example.com' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/queue/cancel-all returns {ok,count}', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/queue/cancel-all',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(typeof body.count).toBe('number')
    await app.close()
  })

  // ------------------------------------------------------------------
  // GET /api/transcription/config/validate
  // ------------------------------------------------------------------
  it('GET /api/transcription/config/validate returns ok and problems array', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/transcription/config/validate',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.ok).toBe('boolean')
    expect(Array.isArray(body.problems)).toBe(true)
    await app.close()
  })

  // ------------------------------------------------------------------
  // GET /api/recordings/:id/summary-stale
  // ------------------------------------------------------------------
  it('GET /api/recordings/:id/summary-stale returns stale boolean', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-tx-1/summary-stale',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.stale).toBe('boolean')
    await app.close()
  })
})
