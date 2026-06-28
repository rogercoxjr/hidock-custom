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

const sampleFiles = [
  { filename: 'rec1.hda', size: 1024, duration: 60.5, dateCreated: '2024-01-03T10:00:00Z' },
  { filename: 'rec2.hda', size: 2048, duration: 120.0, dateCreated: '2024-01-02T10:00:00Z' }
]

describe('device-cache endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-dc-'))
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

  // ── auth guards ───────────────────────────────────────────────────────────

  it('GET /api/device-cache without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/device-cache' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('PUT /api/device-cache without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'PUT',
      url: '/api/device-cache',
      headers: { 'content-type': 'application/json' },
      payload: { files: sampleFiles }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('DELETE /api/device-cache without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'DELETE', url: '/api/device-cache' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  // ── foreign origin guard (write endpoints) ───────────────────────────────

  it('PUT /api/device-cache with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PUT',
      url: '/api/device-cache',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { files: sampleFiles }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // ── real-DB behaviour ─────────────────────────────────────────────────────

  it('GET /api/device-cache returns empty array when cache is uninitialised', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/device-cache',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await app.close()
  })

  it('PUT /api/device-cache stores files; GET returns them ordered by dateCreated DESC', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const put = await app.inject({
      method: 'PUT',
      url: '/api/device-cache',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { files: sampleFiles }
    })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toEqual({ ok: true, count: 2 })

    const get = await app.inject({
      method: 'GET',
      url: '/api/device-cache',
      cookies: { hidock_session: cookie }
    })
    expect(get.statusCode).toBe(200)
    const items = get.json() as Array<typeof sampleFiles[0]>
    expect(items).toHaveLength(2)
    // ordered DESC by dateCreated: rec1 (2024-01-03) > rec2 (2024-01-02)
    expect(items[0].filename).toBe('rec1.hda')
    expect(items[1].filename).toBe('rec2.hda')

    await app.close()
  })

  it('PUT /api/device-cache replaces the previous cache (not appended)', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // First PUT with 2 files
    await app.inject({
      method: 'PUT',
      url: '/api/device-cache',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { files: sampleFiles }
    })

    // Second PUT with 1 different file
    const replacement = [
      { filename: 'rec3.hda', size: 512, duration: 30.0, dateCreated: '2024-01-05T10:00:00Z' }
    ]
    await app.inject({
      method: 'PUT',
      url: '/api/device-cache',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { files: replacement }
    })

    const get = await app.inject({
      method: 'GET',
      url: '/api/device-cache',
      cookies: { hidock_session: cookie }
    })
    expect(get.statusCode).toBe(200)
    const items = get.json() as Array<{ filename: string }>
    expect(items).toHaveLength(1)
    expect(items[0].filename).toBe('rec3.hda')

    await app.close()
  })

  it('DELETE /api/device-cache clears all files', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Seed the cache
    await app.inject({
      method: 'PUT',
      url: '/api/device-cache',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { files: sampleFiles }
    })

    const del = await app.inject({
      method: 'DELETE',
      url: '/api/device-cache',
      cookies: { hidock_session: cookie }
    })
    expect(del.statusCode).toBe(200)
    expect(del.json()).toEqual({ ok: true })

    const get = await app.inject({
      method: 'GET',
      url: '/api/device-cache',
      cookies: { hidock_session: cookie }
    })
    expect(get.statusCode).toBe(200)
    expect(get.json()).toEqual([])

    await app.close()
  })

  it('DELETE /api/device-cache is idempotent when cache does not exist', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Delete without any prior PUT (table may not exist yet)
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/device-cache',
      cookies: { hidock_session: cookie }
    })
    expect(del.statusCode).toBe(200)
    expect(del.json()).toEqual({ ok: true })

    await app.close()
  })
})
