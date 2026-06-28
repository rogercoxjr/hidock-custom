/**
 * Real-DB tests for the summarization REST router (0c-4).
 *
 * The two endpoints both call out to the Ollama Cloud API (ollama.com).
 * We mock `fetch` with `vi.stubGlobal` so the tests run offline and
 * deterministically, while still exercising:
 *   - route registration, auth guards, and same-origin guards
 *   - request validation (Zod schemas)
 *   - correct HTTP-status classification (401→key-rejected, 404→model-not-found, 429→quota, 5xx→error)
 *   - success paths
 *
 * Covered routes:
 *   GET  /api/summarization/models           — 401 (unauth), 403 (non-admin), 200 success; fetch URL verified
 *   POST /api/summarization/test-connection  — 401, 403 (foreign origin), 403 (non-admin), 200, 400 (key rejected); fetch URL verified
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildApp } from '../app'
import { createFakeOidc } from '../oidc'
import { testDeps } from './app.test'

// Helper: log in as a non-admin member (used to assert 403 on admin-only routes)
async function loginAsMember(app: Awaited<ReturnType<typeof buildApp>>) {
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

// ---------------------------------------------------------------------------
// Mock config so tests don't need a real config file on disk
// ---------------------------------------------------------------------------

vi.mock('../../main/services/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/services/config')>()
  return {
    ...actual,
    getConfig: vi.fn().mockReturnValue({
      summarization: {
        ollamaCloudApiKey: 'saved-key',
        ollamaCloudModel: 'saved-model'
      }
    })
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeApp() {
  return buildApp(
    testDeps({ oidc: createFakeOidc({ email: 'boss@x.com', emailVerified: true, sub: 'sub-boss' }) })
  )
}

// Non-admin member app — used to verify admin-only routes return 403
async function makeMemberApp() {
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

/** Build a minimal Response-like object for vi.stubGlobal('fetch', ...) */
function mockResponse(
  status: number,
  body: unknown,
  textBody?: string
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(textBody ?? JSON.stringify(body))
  } as unknown as Response
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('summarization REST router', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-summ-'))
    process.env.HIDOCK_DATA_ROOT = dir
    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, upsertAllowedUser } = await import('../../main/services/database')
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')
    // Seed a non-admin member for admin-guard tests
    upsertAllowedUser({ email: 'member@x.com', invitedBy: 'boss@x.com' })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
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
  // GET /api/summarization/models
  // -------------------------------------------------------------------------

  it('GET /api/summarization/models without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/summarization/models' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/summarization/models returns model list on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse(200, { models: [{ name: 'llama3.2' }, { name: 'mistral' }] })
      )
    )

    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/summarization/models',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.success).toBe(true)
    expect(body.models).toEqual(['llama3.2', 'mistral'])
    await app.close()
  })

  it('GET /api/summarization/models uses saved config key (no ?apiKey= param accepted)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(200, { models: [{ name: 'model-x' }] })
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = await makeApp()
    const cookie = await login(app)
    await app.inject({
      method: 'GET',
      url: '/api/summarization/models',
      cookies: { hidock_session: cookie }
    })
    const calledHeaders = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    // Must use the saved config key — ?apiKey= query param was removed to prevent
    // API key exposure in server logs and browser history.
    expect(calledHeaders['Authorization']).toBe('Bearer saved-key')
    await app.close()
  })

  it('GET /api/summarization/models fetch targets api.ollama.com (not ollama.com)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(200, { models: [] })
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = await makeApp()
    const cookie = await login(app)
    await app.inject({
      method: 'GET',
      url: '/api/summarization/models',
      cookies: { hidock_session: cookie }
    })
    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toBe('https://api.ollama.com/api/tags')
    await app.close()
  })

  it('GET /api/summarization/models with non-admin user returns 403', async () => {
    vi.stubGlobal('fetch', vi.fn()) // should not be called

    const app = await makeMemberApp()
    const cookie = await loginAsMember(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/summarization/models',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('GET /api/summarization/models returns 400 when Ollama returns non-ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse(500, {}, 'internal server error'))
    )

    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/summarization/models',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('HTTP 500')
    await app.close()
  })

  // -------------------------------------------------------------------------
  // POST /api/summarization/test-connection
  // -------------------------------------------------------------------------

  it('POST /api/summarization/test-connection without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/summarization/test-connection',
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/summarization/test-connection with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/summarization/test-connection',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: {}
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/summarization/test-connection returns success:true on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse(200, { message: { content: 'pong' } }))
    )

    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/summarization/test-connection',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { apiKey: 'my-key', model: 'llama3.2' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ success: true })
    await app.close()
  })

  it('POST /api/summarization/test-connection returns 400 on 401 from Ollama (key rejected)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse(401, {}, 'unauthorized'))
    )

    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/summarization/test-connection',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('API key was rejected')
    await app.close()
  })

  it('POST /api/summarization/test-connection returns 400 on 404 from Ollama (model not found)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse(404, {}, 'not found'))
    )

    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/summarization/test-connection',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { model: 'no-such-model' }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('not found')
    await app.close()
  })

  it('POST /api/summarization/test-connection returns 400 on 429 from Ollama (quota)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse(429, {}, 'too many requests'))
    )

    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/summarization/test-connection',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('quota exceeded')
    await app.close()
  })

  it('POST /api/summarization/test-connection uses inline apiKey + model over saved config', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(200, { message: { content: 'pong' } })
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = await makeApp()
    const cookie = await login(app)
    await app.inject({
      method: 'POST',
      url: '/api/summarization/test-connection',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { apiKey: 'inline-api-key', model: 'inline-model' }
    })
    const calledBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    const calledHeaders = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(calledHeaders['Authorization']).toBe('Bearer inline-api-key')
    expect(calledBody.model).toBe('inline-model')
    await app.close()
  })

  it('POST /api/summarization/test-connection fetch targets api.ollama.com (not ollama.com)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(200, { message: { content: 'pong' } })
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = await makeApp()
    const cookie = await login(app)
    await app.inject({
      method: 'POST',
      url: '/api/summarization/test-connection',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toBe('https://api.ollama.com/api/chat')
    await app.close()
  })

  it('POST /api/summarization/test-connection with non-admin user returns 403', async () => {
    vi.stubGlobal('fetch', vi.fn()) // should not be called

    const app = await makeMemberApp()
    const cookie = await loginAsMember(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/summarization/test-connection',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})
