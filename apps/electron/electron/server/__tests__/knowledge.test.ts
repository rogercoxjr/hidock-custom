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

describe('knowledge endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-knowledge-'))
    process.env.HIDOCK_DATA_ROOT = dir

    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, run } = await import('../../main/services/database')
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')

    // Seed 3 knowledge captures
    run(
      `INSERT INTO knowledge_captures (id, title, summary, category, status, quality_rating, storage_tier, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['kc-1', 'Alpha', 'Summary A', 'meeting', 'ready', 'valuable', 'hot', '2024-01-03T10:00:00Z']
    )
    run(
      `INSERT INTO knowledge_captures (id, title, summary, category, status, quality_rating, storage_tier, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['kc-2', 'Beta', 'Summary B', 'meeting', 'ready', 'unrated', 'hot', '2024-01-02T10:00:00Z']
    )
    run(
      `INSERT INTO knowledge_captures (id, title, summary, category, status, quality_rating, storage_tier, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['kc-3', 'Gamma', 'Summary C', 'project', 'enriched', 'low-value', 'cold', '2024-01-01T10:00:00Z']
    )
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

  // --- GET /api/knowledge (list) ---

  it('GET /api/knowledge without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/knowledge' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/knowledge returns paginated list with total', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/knowledge?limit=2&offset=0',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.total).toBe(3)
    expect(json.items).toHaveLength(2)
    await app.close()
  })

  it('GET /api/knowledge?status=enriched filters by status', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/knowledge?status=enriched',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.total).toBe(1)
    expect(json.items[0].id).toBe('kc-3')
    await app.close()
  })

  it('GET /api/knowledge?quality=valuable filters by quality', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/knowledge?quality=valuable',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.total).toBe(1)
    expect(json.items[0].id).toBe('kc-1')
    await app.close()
  })

  it('GET /api/knowledge?category=project filters by category', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/knowledge?category=project',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.total).toBe(1)
    expect(json.items[0].id).toBe('kc-3')
    await app.close()
  })

  it('GET /api/knowledge with offset paginates', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/knowledge?limit=2&offset=2',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.total).toBe(3)
    expect(json.items).toHaveLength(1)
    await app.close()
  })

  // --- GET /api/knowledge/:id ---

  it('GET /api/knowledge/:id returns the capture', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/knowledge/kc-1',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.id).toBe('kc-1')
    expect(json.title).toBe('Alpha')
    expect(json.quality).toBe('valuable')
    await app.close()
  })

  it('GET /api/knowledge/:id returns 404 for unknown id', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/knowledge/does-not-exist',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // --- POST /api/knowledge/by-ids ---

  it('POST /api/knowledge/by-ids returns matching captures', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge/by-ids',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { ids: ['kc-1', 'kc-3'] }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(Array.isArray(json)).toBe(true)
    expect(json).toHaveLength(2)
    const ids = json.map((x: { id: string }) => x.id).sort()
    expect(ids).toEqual(['kc-1', 'kc-3'])
    await app.close()
  })

  it('POST /api/knowledge/by-ids with empty ids returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge/by-ids',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { ids: [] }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  // --- PATCH /api/knowledge/:id ---

  it('PATCH /api/knowledge/:id updates fields and persists', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/knowledge/kc-2',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { title: 'Beta Updated', status: 'enriched', quality: 'valuable' }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.id).toBe('kc-2')
    expect(json.title).toBe('Beta Updated')
    expect(json.status).toBe('enriched')
    expect(json.quality).toBe('valuable')

    // Verify it persists with a re-GET
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/knowledge/kc-2',
      cookies: { hidock_session: cookie }
    })
    expect(getRes.json().title).toBe('Beta Updated')
    expect(getRes.json().quality).toBe('valuable')

    await app.close()
  })

  it('PATCH /api/knowledge/:id returns 404 for unknown id', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/knowledge/no-such-id',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { title: 'X' }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('PATCH /api/knowledge/:id with empty body returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/knowledge/kc-1',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('PATCH /api/knowledge/:id without auth returns 401', async () => {
    const app = await makeApp()

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/knowledge/kc-1',
      headers: { 'content-type': 'application/json' },
      payload: { title: 'X' }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('PATCH /api/knowledge/:id with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/knowledge/kc-1',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { title: 'X' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})
