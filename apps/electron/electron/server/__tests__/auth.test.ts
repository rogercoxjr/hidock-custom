import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildApp } from '../app'
import { createFakeOidc } from '../oidc'
import { testDeps } from './app.test'

async function makeApp(oidcEmail: string) {
  return buildApp(testDeps({ oidc: createFakeOidc({ email: oidcEmail, emailVerified: true, sub: 'sub-' + oidcEmail }) }))
}

// Drive login → callback; return the callback response + the session cookie to reuse.
async function login(app: Awaited<ReturnType<typeof buildApp>>) {
  const start = await app.inject({ method: 'GET', url: '/auth/login' })
  const startCookie = start.cookies.find((c) => c.name === 'hidock_session')!
  const cb = await app.inject({
    method: 'GET', url: '/auth/callback?code=x&state=ignored-by-fake',
    cookies: { hidock_session: startCookie.value }
  })
  const cbCookie = cb.cookies.find((c) => c.name === 'hidock_session')
  return { start, cb, sessionCookie: (cbCookie ?? startCookie).value }
}

describe('auth routes', () => {
  let dir: string
  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-auth-'))
    process.env.HIDOCK_DATA_ROOT = dir
    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin } = await import('../../main/services/database')
    await initializeFileStorage(); await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')
  })
  afterEach(async () => {
    const { closeDatabase } = await import('../../main/services/database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true }); delete process.env.HIDOCK_DATA_ROOT
  })

  it('GET /auth/login redirects to the provider', async () => {
    const app = await makeApp('boss@x.com')
    const res = await app.inject({ method: 'GET', url: '/auth/login' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain('accounts.google.com')
    await app.close()
  })

  it('an allow-listed user gets a session; /api/me returns their role', async () => {
    const app = await makeApp('boss@x.com')
    const { sessionCookie } = await login(app)
    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { hidock_session: sessionCookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ email: 'boss@x.com', role: 'admin' })
    await app.close()
  })

  it('a non-invited user is denied (403) at callback', async () => {
    const app = await makeApp('stranger@x.com')
    const { cb } = await login(app)
    expect(cb.statusCode).toBe(403)
    await app.close()
  })

  it('callback with no login-in-progress session → 400', async () => {
    const app = await makeApp('boss@x.com')
    const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x' }) // no session cookie
    expect(cb.statusCode).toBe(400)
    await app.close()
  })

  it('a revoked user is rejected by the guard (401)', async () => {
    const app = await makeApp('boss@x.com')
    const { sessionCookie } = await login(app)
    const { setAllowedUserStatus } = await import('../../main/services/database')
    setAllowedUserStatus('boss@x.com', 'revoked')
    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { hidock_session: sessionCookie } })
    expect(me.statusCode).toBe(401)
    await app.close()
  })

  it('logout clears the session (subsequent /api/me is 401)', async () => {
    const app = await makeApp('boss@x.com')
    const { sessionCookie } = await login(app)
    const out = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { hidock_session: sessionCookie } })
    expect(out.statusCode).toBe(204)
    const cleared = out.cookies.find((c) => c.name === 'hidock_session')
    const me = await app.inject({ method: 'GET', url: '/api/me',
      cookies: { hidock_session: cleared ? cleared.value : '' } })
    expect(me.statusCode).toBe(401)
    await app.close()
  })
})
