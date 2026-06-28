import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildApp } from '../app'
import { createFakeOidc } from '../oidc'
import { testDeps } from './app.test'

// Admin user: boss@x.com (matches testDeps adminEmail default)
async function makeApp() {
  return buildApp(
    testDeps({ oidc: createFakeOidc({ email: 'boss@x.com', emailVerified: true, sub: 'sub-boss' }) })
  )
}

// Non-admin user
async function makeAppMember() {
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

describe('config REST endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-cfg-'))
    process.env.HIDOCK_DATA_ROOT = dir

    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, upsertAllowedUser } = await import(
      '../../main/services/database'
    )
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')
    // Add a non-admin member
    upsertAllowedUser({ email: 'member@x.com', role: 'member', invitedBy: 'boss@x.com' })
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

  // ── GET /api/config ──────────────────────────────────────────────────

  it('GET /api/config without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/config' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/config returns full AppConfig object', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/config',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // The config has well-known top-level keys
    expect(body).toHaveProperty('version')
    expect(body).toHaveProperty('storage')
    expect(body).toHaveProperty('transcription')
    expect(body).toHaveProperty('ui')
    await app.close()
  })

  it('GET /api/config?key=ui returns the ui section', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/config?key=ui',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.key).toBe('ui')
    expect(body.value).toHaveProperty('theme')
    await app.close()
  })

  it('GET /api/config?key=nonexistent returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/config?key=nonexistent',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  // ── PATCH /api/config ────────────────────────────────────────────────

  it('PATCH /api/config without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: { 'content-type': 'application/json' },
      payload: { ui: { theme: 'dark' } }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('PATCH /api/config as non-admin returns 403', async () => {
    const app = await makeAppMember()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { ui: { theme: 'dark' } }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('PATCH /api/config with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { ui: { theme: 'dark' } }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('PATCH /api/config merges partial config and returns updated config', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { ui: { theme: 'dark' } }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // The merge should have applied the theme change
    expect(body.ui.theme).toBe('dark')
    // Other top-level keys must still be present (merge, not replace)
    expect(body).toHaveProperty('transcription')
    expect(body).toHaveProperty('storage')
    await app.close()
  })

  it('PATCH /api/config persists — a subsequent GET reflects the change', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    await app.inject({
      method: 'PATCH',
      url: '/api/config',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { ui: { theme: 'light' } }
    })

    const getRes = await app.inject({
      method: 'GET',
      url: '/api/config',
      cookies: { hidock_session: cookie }
    })
    expect(getRes.statusCode).toBe(200)
    expect(getRes.json().ui.theme).toBe('light')
    await app.close()
  })
})
