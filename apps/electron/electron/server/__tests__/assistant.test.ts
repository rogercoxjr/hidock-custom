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

describe('assistant REST endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-asst-'))
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

  // --- Auth guard ---

  it('GET /api/assistant/conversations without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/assistant/conversations' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  // --- Conversations CRUD ---

  it('GET /api/assistant/conversations returns paginated empty list', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/assistant/conversations',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(0)
    expect(body.items).toHaveLength(0)
    await app.close()
  })

  it('POST /api/assistant/conversations creates a conversation and returns 201', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/assistant/conversations',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { title: 'My Chat' }
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(typeof body.id).toBe('string')
    expect(body.title).toBe('My Chat')
    expect(body.createdAt).toBeTruthy()
    expect(body.updatedAt).toBeTruthy()
    await app.close()
  })

  it('POST /api/assistant/conversations defaults title to "New Conversation"', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/assistant/conversations',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().title).toBe('New Conversation')
    await app.close()
  })

  it('POST /api/assistant/conversations with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/assistant/conversations',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { title: 'Bad' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('GET /api/assistant/conversations/:id returns the conversation', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    // Create
    const created = await app.inject({
      method: 'POST',
      url: '/api/assistant/conversations',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { title: 'Fetch Me' }
    })
    const { id } = created.json()
    // Fetch
    const res = await app.inject({
      method: 'GET',
      url: `/api/assistant/conversations/${id}`,
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().id).toBe(id)
    expect(res.json().title).toBe('Fetch Me')
    await app.close()
  })

  it('GET /api/assistant/conversations/:id returns 404 for unknown id', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/assistant/conversations/does-not-exist',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('PATCH /api/assistant/conversations/:id updates title', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    // Create
    const created = await app.inject({
      method: 'POST',
      url: '/api/assistant/conversations',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { title: 'Old Title' }
    })
    const { id } = created.json()
    // Patch
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/assistant/conversations/${id}`,
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { title: 'New Title' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().title).toBe('New Title')
    // Verify persisted
    const get = await app.inject({
      method: 'GET',
      url: `/api/assistant/conversations/${id}`,
      cookies: { hidock_session: cookie }
    })
    expect(get.json().title).toBe('New Title')
    await app.close()
  })

  it('PATCH /api/assistant/conversations/:id returns 404 for unknown id', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/assistant/conversations/no-such-id',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { title: 'X' }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('DELETE /api/assistant/conversations/:id removes it', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    // Create
    const created = await app.inject({
      method: 'POST',
      url: '/api/assistant/conversations',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { title: 'To Delete' }
    })
    const { id } = created.json()
    // Delete
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/assistant/conversations/${id}`,
      cookies: { hidock_session: cookie }
    })
    expect(del.statusCode).toBe(200)
    expect(del.json()).toEqual({ ok: true })
    // Confirm gone
    const get = await app.inject({
      method: 'GET',
      url: `/api/assistant/conversations/${id}`,
      cookies: { hidock_session: cookie }
    })
    expect(get.statusCode).toBe(404)
    await app.close()
  })

  it('DELETE /api/assistant/conversations/:id returns 404 for unknown id', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/assistant/conversations/no-such-id',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // --- Pagination ---

  it('GET /api/assistant/conversations paginates with limit/offset', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    // Create 3 conversations
    for (let i = 1; i <= 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/assistant/conversations',
        cookies: { hidock_session: cookie },
        headers: { 'content-type': 'application/json' },
        payload: { title: `Conv ${i}` }
      })
    }
    const res = await app.inject({
      method: 'GET',
      url: '/api/assistant/conversations?limit=2&offset=0',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(3)
    expect(body.items).toHaveLength(2)
    await app.close()
  })

  // --- Messages ---

  it('GET /api/assistant/conversations/:id/messages returns empty array initially', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const created = await app.inject({
      method: 'POST',
      url: '/api/assistant/conversations',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    const { id } = created.json()
    const res = await app.inject({
      method: 'GET',
      url: `/api/assistant/conversations/${id}/messages`,
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
    expect(res.json()).toHaveLength(0)
    await app.close()
  })

  it('POST /api/assistant/conversations/:id/messages adds a message', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const created = await app.inject({
      method: 'POST',
      url: '/api/assistant/conversations',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    const { id } = created.json()
    const res = await app.inject({
      method: 'POST',
      url: `/api/assistant/conversations/${id}/messages`,
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { role: 'user', content: 'Hello!' }
    })
    expect(res.statusCode).toBe(201)
    const msg = res.json()
    expect(msg.role).toBe('user')
    expect(msg.content).toBe('Hello!')
    expect(msg.conversationId).toBe(id)
    await app.close()
  })

  it('GET /api/assistant/conversations/:id/messages returns messages in order', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const created = await app.inject({
      method: 'POST',
      url: '/api/assistant/conversations',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    const { id } = created.json()
    await app.inject({
      method: 'POST',
      url: `/api/assistant/conversations/${id}/messages`,
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { role: 'user', content: 'First' }
    })
    await app.inject({
      method: 'POST',
      url: `/api/assistant/conversations/${id}/messages`,
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { role: 'assistant', content: 'Second' }
    })
    const res = await app.inject({
      method: 'GET',
      url: `/api/assistant/conversations/${id}/messages`,
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const msgs = res.json()
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('user')
    expect(msgs[1].role).toBe('assistant')
    await app.close()
  })

  it('GET /api/assistant/conversations/:id/messages returns 404 for unknown conversation', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/assistant/conversations/no-such-id/messages',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('POST /api/assistant/conversations/:id/messages returns 404 for unknown conversation', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/assistant/conversations/no-such-id/messages',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { role: 'user', content: 'Hello' }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // --- Context ---

  it('GET /api/assistant/conversations/:id/context returns empty array initially', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const created = await app.inject({
      method: 'POST',
      url: '/api/assistant/conversations',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    const { id } = created.json()
    const res = await app.inject({
      method: 'GET',
      url: `/api/assistant/conversations/${id}/context`,
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
    expect(res.json()).toHaveLength(0)
    await app.close()
  })

  it('GET /api/assistant/conversations/:id/context returns 404 for unknown conversation', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/assistant/conversations/no-such-id/context',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('DELETE /api/assistant/conversations/:id/context returns ok:true (no-op when not present)', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const created = await app.inject({
      method: 'POST',
      url: '/api/assistant/conversations',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    const { id } = created.json()
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/assistant/conversations/${id}/context`,
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { knowledgeCaptureId: 'kc-does-not-exist' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })
})
