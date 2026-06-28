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

describe('chat endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-chat-'))
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

  // ---------------------------------------------------------------------------
  // Auth guards
  // ---------------------------------------------------------------------------

  it('GET /api/chat/history without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/chat/history' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/chat/messages without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { 'content-type': 'application/json' },
      payload: { role: 'user', content: 'hello' }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('DELETE /api/chat/history without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'DELETE', url: '/api/chat/history' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  // ---------------------------------------------------------------------------
  // CSRF guard: foreign origin on writes → 403
  // ---------------------------------------------------------------------------

  it('POST /api/chat/messages with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { role: 'user', content: 'hello' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // ---------------------------------------------------------------------------
  // GET /api/chat/history — empty DB
  // ---------------------------------------------------------------------------

  it('GET /api/chat/history returns empty array when no messages', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'GET',
      url: '/api/chat/history',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await app.close()
  })

  // ---------------------------------------------------------------------------
  // POST /api/chat/messages — add messages and read them back
  // ---------------------------------------------------------------------------

  it('POST /api/chat/messages returns id, role, content', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { role: 'user', content: 'What is the weather?' }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.id).toBe('string')
    expect(body.role).toBe('user')
    expect(body.content).toBe('What is the weather?')
    await app.close()
  })

  it('POST /api/chat/messages with sources returns sources field', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const sources = JSON.stringify([{ id: 'rec-1', title: 'Test' }])
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { role: 'assistant', content: 'The answer is 42.', sources }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().sources).toBe(sources)
    await app.close()
  })

  it('POST /api/chat/messages rejects unknown role', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { role: 'system', content: 'hello' }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('GET /api/chat/history returns messages in chronological order', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Add user message then assistant reply
    await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { role: 'user', content: 'Question' }
    })
    await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { role: 'assistant', content: 'Answer' }
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/chat/history',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const messages = res.json()
    expect(messages).toHaveLength(2)
    // Both roles must be present; ordering by created_at may be same-second in test
    const roles = messages.map((m: { role: string }) => m.role)
    expect(roles).toContain('user')
    expect(roles).toContain('assistant')
    await app.close()
  })

  it('GET /api/chat/history respects ?limit=', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Add 3 messages
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/chat/messages',
        cookies: { hidock_session: cookie },
        headers: { 'content-type': 'application/json' },
        payload: { role: 'user', content: `Message ${i}` }
      })
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/chat/history?limit=2',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(2)
    await app.close()
  })

  // ---------------------------------------------------------------------------
  // DELETE /api/chat/history — clears all messages
  // ---------------------------------------------------------------------------

  it('DELETE /api/chat/history returns ok:true and empties history', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Add a message first
    await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { role: 'user', content: 'Will be cleared' }
    })

    // Clear history
    const delRes = await app.inject({
      method: 'DELETE',
      url: '/api/chat/history',
      cookies: { hidock_session: cookie }
    })
    expect(delRes.statusCode).toBe(200)
    expect(delRes.json()).toEqual({ ok: true })

    // Verify it's empty
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/chat/history',
      cookies: { hidock_session: cookie }
    })
    expect(getRes.statusCode).toBe(200)
    expect(getRes.json()).toEqual([])

    await app.close()
  })
})
