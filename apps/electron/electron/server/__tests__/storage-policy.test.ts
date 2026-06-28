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

describe('storage-policy REST endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-sp-'))
    process.env.HIDOCK_DATA_ROOT = dir

    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, insertRecording } = await import(
      '../../main/services/database'
    )
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')

    // Seed two recordings — no storage_tier set (untiered)
    insertRecording({
      id: 'sp-rec-1',
      filename: 'sp1.hda',
      file_path: null,
      date_recorded: '2020-01-01T10:00:00Z', // old — likely over retention
      status: 'ready',
      location: 'device-only',
      transcription_status: 'none',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0
    })
    insertRecording({
      id: 'sp-rec-2',
      filename: 'sp2.hda',
      file_path: null,
      date_recorded: '2020-01-02T10:00:00Z',
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

  // -------------------------------------------------------------------------
  // Auth guards
  // -------------------------------------------------------------------------

  it('GET /api/storage-policy/stats without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/storage-policy/stats' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/storage-policy/by-tier without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/storage-policy/by-tier?tier=hot' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/storage-policy/cleanup-suggestions without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/storage-policy/cleanup-suggestions' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/storage-policy/execute-cleanup without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/storage-policy/execute-cleanup',
      headers: { 'content-type': 'application/json' },
      payload: { ids: ['sp-rec-1'] }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  // -------------------------------------------------------------------------
  // CSRF guard (foreign Origin → 403 on writes)
  // -------------------------------------------------------------------------

  it('POST /api/storage-policy/execute-cleanup with foreign Origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/storage-policy/execute-cleanup',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      cookies: { hidock_session: cookie },
      payload: { ids: ['sp-rec-1'] }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // -------------------------------------------------------------------------
  // GET /api/storage-policy/stats
  // -------------------------------------------------------------------------

  it('GET /api/storage-policy/stats returns array of tier stats', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/storage-policy/stats',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    // Service always returns all four tiers
    const tiers = body.map((s: { tier: string }) => s.tier)
    expect(tiers).toContain('hot')
    expect(tiers).toContain('warm')
    expect(tiers).toContain('cold')
    expect(tiers).toContain('archive')
    body.forEach((stat: Record<string, unknown>) => {
      expect(typeof stat.count).toBe('number')
      expect(typeof stat.totalSizeBytes).toBe('number')
      expect(typeof stat.avgAgeDays).toBe('number')
    })
    await app.close()
  })

  // -------------------------------------------------------------------------
  // GET /api/storage-policy/by-tier
  // -------------------------------------------------------------------------

  it('GET /api/storage-policy/by-tier?tier=hot returns array', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/storage-policy/by-tier?tier=hot',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
    await app.close()
  })

  it('GET /api/storage-policy/by-tier without tier param returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/storage-policy/by-tier',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('GET /api/storage-policy/by-tier?tier=invalid returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/storage-policy/by-tier?tier=invalid',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  // -------------------------------------------------------------------------
  // GET /api/storage-policy/cleanup-suggestions
  // -------------------------------------------------------------------------

  it('GET /api/storage-policy/cleanup-suggestions returns array', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/storage-policy/cleanup-suggestions',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
    await app.close()
  })

  it('GET /api/storage-policy/cleanup-suggestions?tier=hot returns tier-filtered array', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // First assign hot tier to sp-rec-1 via initialize-untiered + assign-tier
    await app.inject({
      method: 'POST',
      url: '/api/storage-policy/assign-tier',
      headers: { 'content-type': 'application/json' },
      cookies: { hidock_session: cookie },
      payload: { recordingId: 'sp-rec-1', quality: 'high' }
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/storage-policy/cleanup-suggestions?tier=hot',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    // All returned suggestions should be for the hot tier
    body.forEach((s: { currentTier: string }) => {
      expect(s.currentTier).toBe('hot')
    })
    await app.close()
  })

  // -------------------------------------------------------------------------
  // POST /api/storage-policy/initialize-untiered
  // -------------------------------------------------------------------------

  it('POST /api/storage-policy/initialize-untiered returns initialized count', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/storage-policy/initialize-untiered',
      headers: { 'content-type': 'application/json' },
      cookies: { hidock_session: cookie },
      payload: {}
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.initialized).toBe('number')
    // Both seeded recordings are untiered
    expect(body.initialized).toBe(2)
    await app.close()
  })

  it('POST /api/storage-policy/initialize-untiered second run returns 0 (all already tiered)', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // First run
    await app.inject({
      method: 'POST',
      url: '/api/storage-policy/initialize-untiered',
      headers: { 'content-type': 'application/json' },
      cookies: { hidock_session: cookie },
      payload: {}
    })

    // Second run — nothing left to initialize
    const res = await app.inject({
      method: 'POST',
      url: '/api/storage-policy/initialize-untiered',
      headers: { 'content-type': 'application/json' },
      cookies: { hidock_session: cookie },
      payload: {}
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().initialized).toBe(0)
    await app.close()
  })

  // -------------------------------------------------------------------------
  // POST /api/storage-policy/assign-tier
  // -------------------------------------------------------------------------

  it('POST /api/storage-policy/assign-tier assigns tier and returns ok:true', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/storage-policy/assign-tier',
      headers: { 'content-type': 'application/json' },
      cookies: { hidock_session: cookie },
      payload: { recordingId: 'sp-rec-1', quality: 'high' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })

  it('POST /api/storage-policy/assign-tier returns 404 for unknown recording', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/storage-policy/assign-tier',
      headers: { 'content-type': 'application/json' },
      cookies: { hidock_session: cookie },
      payload: { recordingId: 'no-such-id', quality: 'low' }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('POST /api/storage-policy/assign-tier rejects invalid quality (400)', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/storage-policy/assign-tier',
      headers: { 'content-type': 'application/json' },
      cookies: { hidock_session: cookie },
      payload: { recordingId: 'sp-rec-1', quality: 'excellent' }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  // -------------------------------------------------------------------------
  // POST /api/storage-policy/execute-cleanup
  // -------------------------------------------------------------------------

  it('POST /api/storage-policy/execute-cleanup returns deleted/archived/failed structure', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Assign a tier first so the recordings are "tiered"
    await app.inject({
      method: 'POST',
      url: '/api/storage-policy/assign-tier',
      headers: { 'content-type': 'application/json' },
      cookies: { hidock_session: cookie },
      payload: { recordingId: 'sp-rec-1', quality: 'high' }
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/storage-policy/execute-cleanup',
      headers: { 'content-type': 'application/json' },
      cookies: { hidock_session: cookie },
      payload: { ids: ['sp-rec-1'] }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.deleted)).toBe(true)
    expect(Array.isArray(body.archived)).toBe(true)
    expect(Array.isArray(body.failed)).toBe(true)
    // Total accounted for = 1
    expect(body.deleted.length + body.archived.length + body.failed.length).toBe(1)
    await app.close()
  })

  it('POST /api/storage-policy/execute-cleanup with unknown ids reports in failed', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/storage-policy/execute-cleanup',
      headers: { 'content-type': 'application/json' },
      cookies: { hidock_session: cookie },
      payload: { ids: ['no-such-id'] }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.failed).toHaveLength(1)
    expect(body.failed[0].id).toBe('no-such-id')
    await app.close()
  })
})
