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

describe('quality REST endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-quality-'))
    process.env.HIDOCK_DATA_ROOT = dir

    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, insertRecording } = await import(
      '../../main/services/database'
    )
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')

    // Seed two recordings
    insertRecording({
      id: 'qrec-1',
      filename: 'qrec1.hda',
      file_path: null,
      date_recorded: '2024-03-01T10:00:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'none',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0
    })
    insertRecording({
      id: 'qrec-2',
      filename: 'qrec2.hda',
      file_path: null,
      date_recorded: '2024-03-02T10:00:00Z',
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

  // -----------------------------------------------------------------------
  // Auth guard
  // -----------------------------------------------------------------------

  it('GET /api/recordings/:id/quality without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/recordings/qrec-1/quality' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('PUT /api/recordings/:id/quality without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'PUT',
      url: '/api/recordings/qrec-1/quality',
      headers: { 'content-type': 'application/json' },
      payload: { quality: 'high' }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  // -----------------------------------------------------------------------
  // CSRF guard (foreign Origin → 403)
  // -----------------------------------------------------------------------

  it('PUT /api/recordings/:id/quality with foreign Origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PUT',
      url: '/api/recordings/qrec-1/quality',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example.com'
      },
      cookies: { hidock_session: cookie },
      payload: { quality: 'high' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // -----------------------------------------------------------------------
  // GET /api/recordings/:id/quality — no assessment yet
  // -----------------------------------------------------------------------

  it('GET /api/recordings/:id/quality returns null when no assessment exists', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/qrec-1/quality',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
    await app.close()
  })

  it('GET /api/recordings/:id/quality returns 404 for unknown recording', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/no-such-id/quality',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // -----------------------------------------------------------------------
  // PUT /api/recordings/:id/quality — manual set
  // -----------------------------------------------------------------------

  it('PUT /api/recordings/:id/quality sets quality and returns assessment', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PUT',
      url: '/api/recordings/qrec-1/quality',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { quality: 'high', reason: 'test reason', assessedBy: 'tester' }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.recording_id).toBe('qrec-1')
    expect(body.quality).toBe('high')
    expect(body.assessment_method).toBe('manual')
    expect(body.reason).toBe('test reason')
    expect(body.assessed_by).toBe('tester')
    await app.close()
  })

  it('PUT /api/recordings/:id/quality persists and is readable via GET', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    await app.inject({
      method: 'PUT',
      url: '/api/recordings/qrec-1/quality',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { quality: 'medium' }
    })

    const getRes = await app.inject({
      method: 'GET',
      url: '/api/recordings/qrec-1/quality',
      cookies: { hidock_session: cookie }
    })
    expect(getRes.statusCode).toBe(200)
    expect(getRes.json().quality).toBe('medium')
    await app.close()
  })

  it('PUT /api/recordings/:id/quality rejects invalid quality value (400)', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PUT',
      url: '/api/recordings/qrec-1/quality',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { quality: 'excellent' }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('PUT /api/recordings/:id/quality returns 404 for unknown recording', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PUT',
      url: '/api/recordings/no-such-id/quality',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { quality: 'low' }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // -----------------------------------------------------------------------
  // POST /api/recordings/:id/quality/auto-assess
  // -----------------------------------------------------------------------

  it('POST /api/recordings/:id/quality/auto-assess returns an assessment', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/qrec-1/quality/auto-assess',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.recording_id).toBe('qrec-1')
    expect(['high', 'medium', 'low']).toContain(body.quality)
    expect(body.assessment_method).toBe('auto')
    await app.close()
  })

  it('POST /api/recordings/:id/quality/auto-assess returns 404 for unknown recording', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/no-such-id/quality/auto-assess',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // -----------------------------------------------------------------------
  // POST /api/quality/batch-assess
  // -----------------------------------------------------------------------

  it('POST /api/quality/batch-assess assesses given ids and returns count', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/quality/batch-assess',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { ids: ['qrec-1', 'qrec-2'] }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.assessed).toBe(2)
    expect(body.items).toHaveLength(2)
    body.items.forEach((item: Record<string, unknown>) => {
      expect(['high', 'medium', 'low']).toContain(item.quality)
    })
    await app.close()
  })

  it('POST /api/quality/batch-assess without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/quality/batch-assess',
      headers: { 'content-type': 'application/json' },
      payload: { ids: ['qrec-1'] }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  // -----------------------------------------------------------------------
  // POST /api/quality/assess-unassessed
  // -----------------------------------------------------------------------

  it('POST /api/quality/assess-unassessed assesses all unassessed recordings', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/quality/assess-unassessed',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.assessed).toBe('number')
    // Both seeded recordings have no quality assessment yet
    expect(body.assessed).toBe(2)
    await app.close()
  })

  it('POST /api/quality/assess-unassessed skips already-assessed recordings', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Pre-assess qrec-1 manually
    await app.inject({
      method: 'PUT',
      url: '/api/recordings/qrec-1/quality',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { quality: 'low' }
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/quality/assess-unassessed',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(200)
    // Only qrec-2 remains unassessed
    expect(res.json().assessed).toBe(1)
    await app.close()
  })
})
