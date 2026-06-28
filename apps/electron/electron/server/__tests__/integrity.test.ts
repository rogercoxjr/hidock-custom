import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildApp } from '../app'
import { createFakeOidc } from '../oidc'
import { testDeps } from './app.test'

// Admin user — matches testDeps.adminEmail 'boss@x.com'
async function makeAdminApp() {
  return buildApp(
    testDeps({ oidc: createFakeOidc({ email: 'boss@x.com', emailVerified: true, sub: 'sub-boss' }) })
  )
}

// Non-admin (member) user
async function makeMemberApp() {
  return buildApp(
    testDeps({ oidc: createFakeOidc({ email: 'member@x.com', emailVerified: true, sub: 'sub-member' }) })
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

describe('integrity REST endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-integrity-'))
    process.env.HIDOCK_DATA_ROOT = dir

    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, upsertAllowedUser, insertRecording } = await import(
      '../../main/services/database'
    )
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')
    upsertAllowedUser({ email: 'member@x.com', role: 'member', invitedBy: 'boss@x.com' })

    // Seed one recording that has a file_path pointing at a real file
    const recsDir = join(dir, 'recordings')
    mkdirSync(recsDir, { recursive: true })
    const filePath = join(recsDir, '2024-01-01_1000.wav')
    // Write a minimal file (> 1 KB so it's not flagged as incomplete)
    writeFileSync(filePath, Buffer.alloc(2048))

    insertRecording({
      id: 'int-rec-1',
      filename: '2024-01-01_1000.wav',
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

    // Seed a recording whose file does NOT exist (for purge test)
    insertRecording({
      id: 'int-rec-missing',
      filename: 'ghost.wav',
      file_path: join(recsDir, 'ghost.wav'),
      date_recorded: '2024-01-02T10:00:00Z',
      status: 'ready',
      location: 'local-only',
      transcription_status: 'none',
      on_device: 0,
      on_local: 1,
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

  // ── Auth / admin guards ────────────────────────────────────────────────

  it('GET /api/integrity/report without auth returns 401', async () => {
    const app = await makeAdminApp()
    const res = await app.inject({ method: 'GET', url: '/api/integrity/report' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/integrity/report as non-admin returns 403', async () => {
    const app = await makeMemberApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrity/report',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/integrity/run-scan without auth returns 401', async () => {
    const app = await makeAdminApp()
    const res = await app.inject({ method: 'POST', url: '/api/integrity/run-scan' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/integrity/run-scan as non-admin returns 403', async () => {
    const app = await makeMemberApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrity/run-scan',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/integrity/run-scan with foreign origin returns 403', async () => {
    const app = await makeAdminApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrity/run-scan',
      cookies: { hidock_session: cookie },
      headers: { origin: 'https://evil.example.com' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/integrity/purge-missing-files as non-admin returns 403', async () => {
    const app = await makeMemberApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrity/purge-missing-files',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/integrity/cleanup-wrongly-named as non-admin returns 403', async () => {
    const app = await makeMemberApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrity/cleanup-wrongly-named',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/integrity/repair-all as non-admin returns 403', async () => {
    const app = await makeMemberApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrity/repair-all',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/integrity/run-startup-checks as non-admin returns 403', async () => {
    const app = await makeMemberApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrity/run-startup-checks',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/integrity/repair-issue as non-admin returns 403', async () => {
    const app = await makeMemberApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrity/repair-issue',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { issueId: 'some-issue-id' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // ── GET /api/integrity/report ──────────────────────────────────────────

  it('GET /api/integrity/report returns null before any scan', async () => {
    const app = await makeAdminApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrity/report',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    // Before a scan the service returns null
    expect(res.json()).toBeNull()
    await app.close()
  })

  // ── POST /api/integrity/run-scan ───────────────────────────────────────

  it('POST /api/integrity/run-scan runs a scan and returns a report', async () => {
    const app = await makeAdminApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrity/run-scan',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('scanStarted')
    expect(body).toHaveProperty('scanCompleted')
    expect(body).toHaveProperty('totalIssues')
    expect(body).toHaveProperty('issues')
    expect(Array.isArray(body.issues)).toBe(true)
    await app.close()
  })

  it('GET /api/integrity/report returns the last scan report after a scan', async () => {
    const app = await makeAdminApp()
    const cookie = await login(app)

    // Run scan first
    await app.inject({
      method: 'POST',
      url: '/api/integrity/run-scan',
      cookies: { hidock_session: cookie }
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/integrity/report',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('scanStarted')
    expect(body).toHaveProperty('issues')
    await app.close()
  })

  // ── POST /api/integrity/run-startup-checks ─────────────────────────────

  it('POST /api/integrity/run-startup-checks returns issuesFound + issuesFixed', async () => {
    const app = await makeAdminApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrity/run-startup-checks',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('issuesFound')
    expect(body).toHaveProperty('issuesFixed')
    expect(typeof body.issuesFound).toBe('number')
    expect(typeof body.issuesFixed).toBe('number')
    await app.close()
  })

  // ── POST /api/integrity/repair-all ────────────────────────────────────

  it('POST /api/integrity/repair-all returns empty array when no scan has been run', async () => {
    const app = await makeAdminApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrity/repair-all',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    // repairAllAuto returns [] when lastReport is null
    expect(res.json()).toEqual([])
    await app.close()
  })

  it('POST /api/integrity/repair-all after a scan returns RepairResult[]', async () => {
    const app = await makeAdminApp()
    const cookie = await login(app)

    // Run scan first to populate lastReport
    await app.inject({
      method: 'POST',
      url: '/api/integrity/run-scan',
      cookies: { hidock_session: cookie }
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/integrity/repair-all',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
    await app.close()
  })

  // ── POST /api/integrity/repair-issue ──────────────────────────────────

  it('POST /api/integrity/repair-issue with missing issueId returns 400', async () => {
    const app = await makeAdminApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrity/repair-issue',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}  // missing issueId
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('POST /api/integrity/repair-issue returns failure when no scan report exists', async () => {
    const app = await makeAdminApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrity/repair-issue',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { issueId: 'some-issue-id' }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/No scan report/)
    await app.close()
  })

  // ── POST /api/integrity/purge-missing-files ───────────────────────────

  it('POST /api/integrity/purge-missing-files removes rows with missing files', async () => {
    const app = await makeAdminApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrity/purge-missing-files',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('totalRecords')
    expect(body).toHaveProperty('deleted')
    expect(body).toHaveProperty('kept')
    expect(body).toHaveProperty('deletedFiles')
    // int-rec-missing should be purged (ghost.wav doesn't exist)
    expect(body.deleted).toBeGreaterThanOrEqual(1)
    // int-rec-1 has an existing file — it should be kept
    expect(body.kept).toBeGreaterThanOrEqual(1)
    await app.close()
  })

  // ── POST /api/integrity/cleanup-wrongly-named ─────────────────────────

  it('POST /api/integrity/cleanup-wrongly-named returns cleanup result', async () => {
    const app = await makeAdminApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrity/cleanup-wrongly-named',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('deletedFiles')
    expect(body).toHaveProperty('keptFiles')
    expect(body).toHaveProperty('clearedDbRecords')
    expect(Array.isArray(body.deletedFiles)).toBe(true)
    expect(Array.isArray(body.keptFiles)).toBe(true)
    expect(typeof body.clearedDbRecords).toBe('number')
    await app.close()
  })
})
