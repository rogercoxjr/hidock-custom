import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildApp } from '../app'
import { createFakeOidc } from '../oidc'
import { testDeps } from './app.test'

async function makeAdminApp() {
  return buildApp(
    testDeps({ oidc: createFakeOidc({ email: 'boss@x.com', emailVerified: true, sub: 'sub-boss' }) })
  )
}

async function makeNonAdminApp() {
  return buildApp(
    testDeps({
      oidc: createFakeOidc({ email: 'member@x.com', emailVerified: true, sub: 'sub-member' })
    })
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

describe('migration endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-mig-'))
    process.env.HIDOCK_DATA_ROOT = dir
    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, upsertAllowedUser } = await import(
      '../../main/services/database'
    )
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')
    // Add a non-admin member to test 403 (requireAdmin) responses
    upsertAllowedUser({ email: 'member@x.com', role: 'member' })
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

  // --- Unauthenticated (401) ---

  it('GET /api/migration/status without auth returns 401', async () => {
    const app = await makeAdminApp()
    const res = await app.inject({ method: 'GET', url: '/api/migration/status' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/migration/preview without auth returns 401', async () => {
    const app = await makeAdminApp()
    const res = await app.inject({ method: 'GET', url: '/api/migration/preview' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/migration/run-cleanup without auth returns 401', async () => {
    const app = await makeAdminApp()
    const res = await app.inject({ method: 'POST', url: '/api/migration/run-cleanup' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  // --- Non-admin (403) ---

  it('GET /api/migration/status as non-admin returns 403', async () => {
    const app = await makeNonAdminApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/migration/status',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/migration/run-cleanup as non-admin returns 403', async () => {
    const app = await makeNonAdminApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/migration/run-cleanup',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // --- Authenticated + admin: real DB assertions ---

  it('GET /api/migration/status returns counts for empty DB', async () => {
    const app = await makeAdminApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/migration/status',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.pending).toBe('number')
    expect(typeof body.migrated).toBe('number')
    expect(typeof body.skipped).toBe('number')
    expect(typeof body.total).toBe('number')
    // Empty DB: all zeros
    expect(body.total).toBe(0)
    await app.close()
  })

  it('GET /api/migration/status reflects seeded recordings', async () => {
    const { insertRecording } = await import('../../main/services/database')
    insertRecording({
      id: 'rec-mig-1',
      filename: 'mig1.hda',
      file_path: null,
      date_recorded: '2024-01-01T10:00:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'none',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0
    })

    const app = await makeAdminApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/migration/status',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBeGreaterThanOrEqual(1)
    await app.close()
  })

  it('GET /api/migration/preview returns the three preview arrays', async () => {
    const app = await makeAdminApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/migration/preview',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.orphanedTranscripts)).toBe(true)
    expect(Array.isArray(body.duplicateRecordings)).toBe(true)
    expect(Array.isArray(body.invalidMeetingRefs)).toBe(true)
    await app.close()
  })

  it('POST /api/migration/run-cleanup returns cleanup result shape', async () => {
    const app = await makeAdminApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/migration/run-cleanup',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.success).toBe('boolean')
    expect(typeof body.orphanedTranscriptsRemoved).toBe('number')
    expect(typeof body.duplicateRecordingsRemoved).toBe('number')
    expect(typeof body.invalidMeetingRefsFixed).toBe('number')
    expect(Array.isArray(body.errors)).toBe(true)
    await app.close()
  })

  it('POST /api/migration/run-cleanup with foreign origin returns 403', async () => {
    const app = await makeAdminApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/migration/run-cleanup',
      cookies: { hidock_session: cookie },
      headers: { origin: 'https://evil.example.com' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/migration/run-v11 returns migration result shape on empty DB', async () => {
    const app = await makeAdminApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/migration/run-v11',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.success).toBe('boolean')
    expect(typeof body.capturesCreated).toBe('number')
    expect(Array.isArray(body.errors)).toBe(true)
    expect(typeof body.verified).toBe('boolean')
    await app.close()
  })

  it('POST /api/migration/rollback-v11 returns rollback result shape', async () => {
    const app = await makeAdminApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/migration/rollback-v11',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.success).toBe('boolean')
    expect(Array.isArray(body.errors)).toBe(true)
    await app.close()
  })
})
