import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildApp } from '../app'
import { createFakeOidc } from '../oidc'
import { testDeps } from './app.test'

async function makeApp(oidcEmail: string) {
  return buildApp(testDeps({ oidc: createFakeOidc({ email: oidcEmail, emailVerified: true, sub: 's' }) }))
}
async function loginAs(app: Awaited<ReturnType<typeof buildApp>>) {
  const start = await app.inject({ method: 'GET', url: '/auth/login' })
  const c = start.cookies.find((x) => x.name === 'hidock_session')!
  const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x', cookies: { hidock_session: c.value } })
  return (cb.cookies.find((x) => x.name === 'hidock_session') ?? c).value
}

describe('admin users routes', () => {
  let dir: string
  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-admin-')); process.env.HIDOCK_DATA_ROOT = dir
    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, upsertAllowedUser } = await import('../../main/services/database')
    await initializeFileStorage(); await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')
    upsertAllowedUser({ email: 'member@x.com', invitedBy: 'boss@x.com' })
  })
  afterEach(async () => {
    const { closeDatabase } = await import('../../main/services/database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true }); delete process.env.HIDOCK_DATA_ROOT
  })

  it('admin can list users', async () => {
    const app = await makeApp('boss@x.com'); const cookie = await loginAs(app)
    const res = await app.inject({ method: 'GET', url: '/api/admin/users', cookies: { hidock_session: cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json().users.map((u: { email: string }) => u.email)).toContain('member@x.com')
    await app.close()
  })

  it('admin can invite, change role, and revoke (via PATCH status)', async () => {
    const app = await makeApp('boss@x.com'); const cookie = await loginAs(app)
    const inv = await app.inject({ method: 'POST', url: '/api/admin/users',
      cookies: { hidock_session: cookie }, payload: { email: 'new@x.com' } })
    expect(inv.statusCode).toBe(201)
    const patch = await app.inject({ method: 'PATCH', url: '/api/admin/users',
      cookies: { hidock_session: cookie }, payload: { email: 'new@x.com', role: 'admin' } })
    expect(patch.statusCode).toBe(200)
    const revoke = await app.inject({ method: 'PATCH', url: '/api/admin/users',
      cookies: { hidock_session: cookie }, payload: { email: 'new@x.com', status: 'revoked' } })
    expect(revoke.statusCode).toBe(200)
    const { getAllowedUser } = await import('../../main/services/database')
    expect(getAllowedUser('new@x.com')?.status).toBe('revoked')
  })

  it('refuses to revoke the last active admin (409)', async () => {
    const app = await makeApp('boss@x.com'); const cookie = await loginAs(app)
    const res = await app.inject({ method: 'PATCH', url: '/api/admin/users',
      cookies: { hidock_session: cookie }, payload: { email: 'boss@x.com', status: 'revoked' } })
    expect(res.statusCode).toBe(409)
    const { getAllowedUser } = await import('../../main/services/database')
    expect(getAllowedUser('boss@x.com')?.status).toBe('active')
  })

  it('refuses to demote the last active admin to member (409)', async () => {
    const app = await makeApp('boss@x.com'); const cookie = await loginAs(app)
    const res = await app.inject({ method: 'PATCH', url: '/api/admin/users',
      cookies: { hidock_session: cookie }, payload: { email: 'boss@x.com', role: 'member' } })
    expect(res.statusCode).toBe(409)
  })

  it('a member is forbidden (403)', async () => {
    const app = await makeApp('member@x.com'); const cookie = await loginAs(app)
    const res = await app.inject({ method: 'GET', url: '/api/admin/users', cookies: { hidock_session: cookie } })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('a mutating request with a foreign Origin is rejected (403)', async () => {
    const app = await makeApp('boss@x.com'); const cookie = await loginAs(app)
    const res = await app.inject({ method: 'POST', url: '/api/admin/users',
      cookies: { hidock_session: cookie }, headers: { origin: 'https://evil.example.com' },
      payload: { email: 'x@x.com' } })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})
