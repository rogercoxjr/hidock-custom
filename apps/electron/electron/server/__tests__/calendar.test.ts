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

describe('calendar REST endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-cal-'))
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

  // ── GET /api/calendar/settings ─────────────────────────────────────────────

  it('GET /api/calendar/settings without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/calendar/settings' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/calendar/settings returns default calendar config', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/calendar/settings',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('icsUrl')
    expect(body).toHaveProperty('syncEnabled')
    expect(body).toHaveProperty('syncIntervalMinutes')
    await app.close()
  })

  // ── PATCH /api/calendar/settings ───────────────────────────────────────────

  it('PATCH /api/calendar/settings without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/calendar/settings',
      headers: { 'content-type': 'application/json' },
      payload: { syncEnabled: false }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('PATCH /api/calendar/settings with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/calendar/settings',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { syncEnabled: false }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('PATCH /api/calendar/settings with no fields returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/calendar/settings',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('PATCH /api/calendar/settings updates syncEnabled and persists', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/calendar/settings',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { syncEnabled: false }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.syncEnabled).toBe(false)

    // Verify via GET
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/calendar/settings',
      cookies: { hidock_session: cookie }
    })
    expect(getRes.json().syncEnabled).toBe(false)

    await app.close()
  })

  it('PATCH /api/calendar/settings updates icsUrl', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/calendar/settings',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { icsUrl: 'https://calendar.example.com/feed.ics' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().icsUrl).toBe('https://calendar.example.com/feed.ics')

    await app.close()
  })

  it('PATCH /api/calendar/settings with invalid icsUrl returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/calendar/settings',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { icsUrl: 'not-a-url' }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('PATCH /api/calendar/settings updates syncIntervalMinutes', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/calendar/settings',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { syncIntervalMinutes: 30 }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().syncIntervalMinutes).toBe(30)

    await app.close()
  })

  // ── GET /api/calendar/last-sync ────────────────────────────────────────────

  it('GET /api/calendar/last-sync without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/calendar/last-sync' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/calendar/last-sync returns lastSyncAt field', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'GET',
      url: '/api/calendar/last-sync',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('lastSyncAt')
    // Default is null (no sync yet)
    expect(body.lastSyncAt).toBeNull()
    await app.close()
  })

  // ── POST /api/calendar/sync ────────────────────────────────────────────────

  it('POST /api/calendar/sync without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/calendar/sync' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/calendar/sync with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/calendar/sync',
      cookies: { hidock_session: cookie },
      headers: { origin: 'https://evil.example.com' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/calendar/sync returns 400 when no icsUrl is configured', async () => {
    // Default config has icsUrl = '' — sync should fail gracefully with 400
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'POST',
      url: '/api/calendar/sync',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/No calendar URL configured/i)
    await app.close()
  })

  it('POST /api/calendar/sync?clear=1 returns 400 when no icsUrl is configured', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'POST',
      url: '/api/calendar/sync?clear=1',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('POST /api/calendar/sync invokes syncCalendar and returns result', async () => {
    // Mock syncCalendar so we don't hit the network
    vi.doMock('../../main/services/calendar-sync', async (importOriginal) => {
      const mod = await importOriginal<typeof import('../../main/services/calendar-sync')>()
      return {
        ...mod,
        syncCalendar: vi.fn().mockResolvedValue({
          success: true,
          meetingsCount: 5,
          lastSync: new Date().toISOString()
        })
      }
    })

    // Seed an icsUrl so the guard passes
    const { updateConfig } = await import('../../main/services/config')
    await updateConfig('calendar', { icsUrl: 'https://calendar.example.com/feed.ics' })

    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'POST',
      url: '/api/calendar/sync',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.success).toBe(true)
    expect(body.meetingsCount).toBe(5)
    await app.close()
  })

  it('POST /api/calendar/sync?clear=1 clears meetings then syncs', async () => {
    // Mock syncCalendar so we don't hit the network
    const mockSync = vi.fn().mockResolvedValue({ success: true, meetingsCount: 2 })
    vi.doMock('../../main/services/calendar-sync', async (importOriginal) => {
      const mod = await importOriginal<typeof import('../../main/services/calendar-sync')>()
      return { ...mod, syncCalendar: mockSync }
    })

    const { updateConfig } = await import('../../main/services/config')
    await updateConfig('calendar', { icsUrl: 'https://calendar.example.com/feed.ics' })

    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'POST',
      url: '/api/calendar/sync?clear=1',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().success).toBe(true)
    expect(mockSync).toHaveBeenCalledOnce()
    await app.close()
  })

  it('POST /api/calendar/sync returns 422 when syncCalendar returns success:false', async () => {
    vi.doMock('../../main/services/calendar-sync', async (importOriginal) => {
      const mod = await importOriginal<typeof import('../../main/services/calendar-sync')>()
      return {
        ...mod,
        syncCalendar: vi.fn().mockResolvedValue({ success: false, meetingsCount: 0, error: 'fetch failed' })
      }
    })

    const { updateConfig } = await import('../../main/services/config')
    await updateConfig('calendar', { icsUrl: 'https://calendar.example.com/feed.ics' })

    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'POST',
      url: '/api/calendar/sync',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('PATCH /api/calendar/settings as non-admin returns 403', async () => {
    const { upsertAllowedUser } = await import('../../main/services/database')
    upsertAllowedUser({ email: 'member@x.com', role: 'member', invitedBy: 'boss@x.com' })

    const memberApp = await buildApp(
      testDeps({ oidc: createFakeOidc({ email: 'member@x.com', emailVerified: true, sub: 'sub-member' }) })
    )

    const start = await memberApp.inject({ method: 'GET', url: '/auth/login' })
    const startCookie = start.cookies.find((c) => c.name === 'hidock_session')!
    const cb = await memberApp.inject({
      method: 'GET',
      url: '/auth/callback?code=x&state=ignored-by-fake',
      cookies: { hidock_session: startCookie.value }
    })
    const memberCookie = (cb.cookies.find((c) => c.name === 'hidock_session') ?? startCookie).value

    const res = await memberApp.inject({
      method: 'PATCH',
      url: '/api/calendar/settings',
      cookies: { hidock_session: memberCookie },
      headers: { 'content-type': 'application/json' },
      payload: { syncEnabled: false }
    })
    expect(res.statusCode).toBe(403)
    await memberApp.close()
  })

  it('POST /api/calendar/sync as non-admin returns 403', async () => {
    const { upsertAllowedUser } = await import('../../main/services/database')
    upsertAllowedUser({ email: 'member@x.com', role: 'member', invitedBy: 'boss@x.com' })

    const memberApp = await buildApp(
      testDeps({ oidc: createFakeOidc({ email: 'member@x.com', emailVerified: true, sub: 'sub-member' }) })
    )

    const start = await memberApp.inject({ method: 'GET', url: '/auth/login' })
    const startCookie = start.cookies.find((c) => c.name === 'hidock_session')!
    const cb = await memberApp.inject({
      method: 'GET',
      url: '/auth/callback?code=x&state=ignored-by-fake',
      cookies: { hidock_session: startCookie.value }
    })
    const memberCookie = (cb.cookies.find((c) => c.name === 'hidock_session') ?? startCookie).value

    const res = await memberApp.inject({
      method: 'POST',
      url: '/api/calendar/sync',
      cookies: { hidock_session: memberCookie }
    })
    expect(res.statusCode).toBe(403)
    await memberApp.close()
  })
})
