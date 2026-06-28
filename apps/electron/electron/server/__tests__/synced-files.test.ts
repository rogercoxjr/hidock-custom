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

describe('synced-files endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-sf-'))
    process.env.HIDOCK_DATA_ROOT = dir
    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, addSyncedFile } = await import(
      '../../main/services/database'
    )
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')

    // Seed two records
    addSyncedFile('REC_001.hda', 'REC_001.wav', join(dir, 'REC_001.wav'), 1024)
    addSyncedFile('REC_002.hda', 'REC_002.wav', join(dir, 'REC_002.wav'), 2048)
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

  it('GET /api/synced-files without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/synced-files' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/synced-files/filenames without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/synced-files/filenames' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/synced-files without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/synced-files',
      headers: { 'content-type': 'application/json' },
      payload: { originalFilename: 'X.hda', localFilename: 'X.wav', filePath: '/data/X.wav' }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('DELETE /api/synced-files without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'DELETE', url: '/api/synced-files?filename=REC_001.hda' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  // -------------------------------------------------------------------------
  // GET /api/synced-files — list all
  // -------------------------------------------------------------------------

  it('GET /api/synced-files returns all seeded records', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/synced-files',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(2)
    await app.close()
  })

  it('GET /api/synced-files records have expected fields', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/synced-files',
      cookies: { hidock_session: cookie }
    })
    const items = res.json() as Array<Record<string, unknown>>
    // Each row should have key fields from the synced_files table
    items.forEach((item) => {
      expect(item).toHaveProperty('original_filename')
      expect(item).toHaveProperty('local_filename')
      expect(item).toHaveProperty('file_path')
    })
    await app.close()
  })

  // -------------------------------------------------------------------------
  // GET /api/synced-files/filenames
  // -------------------------------------------------------------------------

  it('GET /api/synced-files/filenames returns array of original filenames', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/synced-files/filenames',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body).toContain('REC_001.hda')
    expect(body).toContain('REC_002.hda')
    await app.close()
  })

  // -------------------------------------------------------------------------
  // GET /api/synced-files/lookup?filename=
  // -------------------------------------------------------------------------

  it('GET /api/synced-files/lookup without filename returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/synced-files/lookup',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('GET /api/synced-files/lookup?filename= for unknown file returns 404', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/synced-files/lookup?filename=UNKNOWN.hda',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('GET /api/synced-files/lookup?filename= returns matching record', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/synced-files/lookup?filename=REC_001.hda',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.original_filename).toBe('REC_001.hda')
    expect(body.local_filename).toBe('REC_001.wav')
    await app.close()
  })

  // -------------------------------------------------------------------------
  // POST /api/synced-files — add
  // -------------------------------------------------------------------------

  it('POST /api/synced-files with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/synced-files',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { originalFilename: 'X.hda', localFilename: 'X.wav', filePath: '/data/X.wav' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/synced-files with missing fields returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/synced-files',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { originalFilename: 'X.hda' } // missing localFilename + filePath
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('POST /api/synced-files inserts a new record and returns id', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/synced-files',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {
        originalFilename: 'REC_003.hda',
        localFilename: 'REC_003.wav',
        filePath: join(dir, 'REC_003.wav'),
        fileSize: 4096
      }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.id).toBe('string')
    expect(body.id.length).toBeGreaterThan(0)

    // Verify via list endpoint
    const list = await app.inject({
      method: 'GET',
      url: '/api/synced-files',
      cookies: { hidock_session: cookie }
    })
    const items = list.json() as Array<{ original_filename: string }>
    expect(items.some((i) => i.original_filename === 'REC_003.hda')).toBe(true)

    await app.close()
  })

  // -------------------------------------------------------------------------
  // DELETE /api/synced-files?filename=
  // -------------------------------------------------------------------------

  it('DELETE /api/synced-files without filename returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/synced-files',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('DELETE /api/synced-files?filename= for unknown record returns 404', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/synced-files?filename=UNKNOWN.hda',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('DELETE /api/synced-files with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/synced-files?filename=REC_001.hda',
      cookies: { hidock_session: cookie },
      headers: { origin: 'https://evil.example.com' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('DELETE /api/synced-files?filename= removes the record', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const del = await app.inject({
      method: 'DELETE',
      url: '/api/synced-files?filename=REC_001.hda',
      cookies: { hidock_session: cookie }
    })
    expect(del.statusCode).toBe(200)
    expect(del.json()).toEqual({ ok: true })

    // Verify the record is gone
    const lookup = await app.inject({
      method: 'GET',
      url: '/api/synced-files/lookup?filename=REC_001.hda',
      cookies: { hidock_session: cookie }
    })
    expect(lookup.statusCode).toBe(404)

    // Other record should still be there
    const list = await app.inject({
      method: 'GET',
      url: '/api/synced-files',
      cookies: { hidock_session: cookie }
    })
    expect(list.json()).toHaveLength(1)

    await app.close()
  })
})
