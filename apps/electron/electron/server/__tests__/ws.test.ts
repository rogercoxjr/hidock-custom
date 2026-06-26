import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { serialize as serializeCookie } from 'cookie'
import { buildApp } from '../app'
import { createFakeOidc } from '../oidc'
import { testDeps } from './app.test'
import { getBroadcaster } from '../../main/services/broadcaster'

async function makeApp(email: string) {
  return buildApp(testDeps({ oidc: createFakeOidc({ email, emailVerified: true, sub: 's' }) }))
}
async function loginCookie(app: Awaited<ReturnType<typeof buildApp>>) {
  const start = await app.inject({ method: 'GET', url: '/auth/login' })
  const c = start.cookies.find((x) => x.name === 'hidock_session')!
  const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x', cookies: { hidock_session: c.value } })
  const raw = (cb.cookies.find((x) => x.name === 'hidock_session') ?? c).value
  // The session value contains ';' (cipher;nonce). Serialize via cookie.serialize so the
  // semicolon is URL-encoded (%3B) — required when building a Cookie header by hand.
  // app.inject({ cookies: { ... } }) does this automatically via light-my-request; injectWS
  // takes a raw header string so we must encode manually.
  return serializeCookie('hidock_session', raw)
}

describe('WebSocket broadcaster', () => {
  let dir: string
  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-ws-')); process.env.HIDOCK_DATA_ROOT = dir
    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin } = await import('../../main/services/database')
    await initializeFileStorage(); await initializeDatabase(); ensureBootstrapAdmin('boss@x.com')
  })
  afterEach(async () => {
    const { closeDatabase } = await import('../../main/services/database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true }); delete process.env.HIDOCK_DATA_ROOT
  })

  it('rejects an unauthenticated upgrade (401)', async () => {
    const app = await makeApp('boss@x.com'); await app.ready()
    await expect(app.injectWS('/ws')).rejects.toBeTruthy() // upgrade refused before open
    await app.close()
  })

  it('an authenticated client receives a broadcast', async () => {
    const app = await makeApp('boss@x.com'); await app.ready()
    const cookie = await loginCookie(app)
    const ws = await app.injectWS('/ws', { headers: { cookie } })
    const got = new Promise<string>((resolve) => ws.on('message', (d) => resolve(d.toString())))
    getBroadcaster().broadcast('transcription:progress', { recordingId: 'r1', percent: 50 })
    const msg = JSON.parse(await got)
    expect(msg).toEqual({ channel: 'transcription:progress', payload: { recordingId: 'r1', percent: 50 } })
    ws.terminate(); await app.close()
  })

  it('clears the broadcaster on app close (back to no-op)', async () => {
    const app = await makeApp('boss@x.com'); await app.ready()
    await app.close()
    expect(() => getBroadcaster().broadcast('x', 1)).not.toThrow()
  })
})
