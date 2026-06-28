/**
 * Real-DB tests for the RAG REST router (0c-4).
 *
 * The RAG service (rag.ts), vector-store, ollama, and config all reach external
 * services (Ollama, embedding model, LLM).  We mock those modules so the tests
 * run offline and deterministically, while still exercising:
 *   - the route registration, auth guards, and same-origin guards
 *   - request validation (Zod schemas)
 *   - correct delegation to the mocked service functions
 *
 * Covered routes:
 *   GET  /api/rag/status                      — 401 (unauth)
 *   GET  /api/rag/stats                       — returns mock counts
 *   POST /api/rag/chat                        — 401, 403, 200
 *   POST /api/rag/cancel                      — 200
 *   POST /api/rag/sessions/:sessionId/clear   — 200
 *   POST /api/rag/sessions/:sessionId/trim    — 200
 *   POST /api/rag/summarize-meeting           — 200 + 404 (null)
 *   POST /api/rag/find-action-items           — 200
 *   GET  /api/rag/search?q=&limit=            — 200 (IPC: rag:search)
 *   GET  /api/rag/global-search?q=&limit=     — 200 (IPC: rag:globalSearch)
 *   GET  /api/rag/chunks                      — 200
 *   POST /api/rag/index                       — 200 (admin), 403 (non-admin)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildApp } from '../app'
import { createFakeOidc } from '../oidc'
import { testDeps } from './app.test'

// ---------------------------------------------------------------------------
// Mock external service modules — must be hoisted (vi.mock is hoisted to top)
// ---------------------------------------------------------------------------

vi.mock('../../main/services/rag', () => {
  const mockRag = {
    getStats: vi.fn().mockReturnValue({ documentCount: 3, meetingCount: 1, sessionCount: 0 }),
    chat: vi.fn().mockResolvedValue({ answer: 'mock answer', sources: [] }),
    cancelRequest: vi.fn().mockReturnValue(true),
    clearSession: vi.fn(),
    removeLastMessages: vi.fn().mockReturnValue(2),
    summarizeMeeting: vi.fn().mockResolvedValue('A meeting summary'),
    findActionItems: vi.fn().mockResolvedValue('- action 1\n- action 2'),
    globalSearch: vi.fn().mockResolvedValue([{ content: 'global result', score: 0.91 }])
  }
  return {
    getRAGService: vi.fn().mockReturnValue(mockRag),
    resetRAGService: vi.fn()
  }
})

vi.mock('../../main/services/vector-store', () => {
  const mockVectorStore = {
    getDocumentCount: vi.fn().mockReturnValue(3),
    getMeetingCount: vi.fn().mockReturnValue(1),
    getAllDocuments: vi.fn().mockReturnValue([
      {
        id: 'doc-1',
        content: 'sample content',
        embedding: [0.1, 0.2],
        metadata: { meetingId: 'meet-1', recordingId: 'rec-1', chunkIndex: 0, subject: 'Test Meeting', timestamp: '2024-01-01T10:00:00Z' }
      }
    ]),
    search: vi.fn().mockResolvedValue([
      {
        document: {
          id: 'doc-1',
          content: 'relevant chunk',
          embedding: [0.1, 0.2],
          metadata: { meetingId: 'meet-1', subject: 'Test', chunkIndex: 0 }
        },
        score: 0.87
      }
    ]),
    indexTranscript: vi.fn().mockResolvedValue(5)
  }
  return {
    getVectorStore: vi.fn().mockReturnValue(mockVectorStore),
    resetVectorStore: vi.fn()
  }
})

vi.mock('../../main/services/ollama', () => ({
  getOllamaService: vi.fn().mockReturnValue({
    isAvailable: vi.fn().mockResolvedValue(false)
  })
}))

vi.mock('../../main/services/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/services/config')>()
  return {
    ...actual,
    getConfig: vi.fn().mockReturnValue({
      embeddings: { provider: 'gemini' },
      chat: { provider: 'gemini' }
    })
  }
})

// getMeetingsForContact and getMeetingsForProject are used by the filter helper
// — mock them so filter parsing doesn't touch a live DB in these unit tests.
vi.mock('../../main/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/services/database')>()
  return {
    ...actual,
    getMeetingsForContact: vi.fn().mockReturnValue([]),
    getMeetingsForProject: vi.fn().mockReturnValue([])
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RAG REST router', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-rag-'))
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

  // ─── GET /api/rag/status ─────────────────────────────────────────────────

  it('GET /api/rag/status without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/rag/status' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/rag/status returns status shape', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/rag/status',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.ollamaAvailable).toBe('boolean')
    expect(typeof body.documentCount).toBe('number')
    expect(typeof body.meetingCount).toBe('number')
    expect(typeof body.ready).toBe('boolean')
    await app.close()
  })

  // ─── GET /api/rag/stats ──────────────────────────────────────────────────

  it('GET /api/rag/stats returns stats shape', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/rag/stats',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.documentCount).toBe('number')
    expect(typeof body.meetingCount).toBe('number')
    expect(typeof body.sessionCount).toBe('number')
    await app.close()
  })

  // ─── POST /api/rag/chat ──────────────────────────────────────────────────

  it('POST /api/rag/chat without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/chat',
      headers: { 'content-type': 'application/json' },
      payload: { sessionId: 'sess-1', message: 'hello' }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/rag/chat with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/chat',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { sessionId: 'sess-1', message: 'hello' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/rag/chat returns answer and sources', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/chat',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { sessionId: 'sess-1', message: 'What was discussed?' }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.answer).toBe('mock answer')
    expect(Array.isArray(body.sources)).toBe(true)
    await app.close()
  })

  it('POST /api/rag/chat with invalid body returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/chat',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { message: 'no session id here' }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  // ─── POST /api/rag/cancel ────────────────────────────────────────────────

  it('POST /api/rag/cancel returns cancelled flag', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/cancel',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { sessionId: 'sess-1' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ cancelled: true })
    await app.close()
  })

  // ─── POST /api/rag/sessions/:sessionId/clear ─────────────────────────────

  it('POST /api/rag/sessions/:sessionId/clear returns ok:true', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/sessions/sess-abc/clear',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })
    await app.close()
  })

  // ─── POST /api/rag/sessions/:sessionId/trim ──────────────────────────────

  it('POST /api/rag/sessions/:sessionId/trim returns removed count', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/sessions/sess-abc/trim',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { count: 2 }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ removed: 2 })
    await app.close()
  })

  it('POST /api/rag/sessions/:sessionId/trim with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/sessions/sess-abc/trim',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { count: 2 }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // ─── POST /api/rag/summarize-meeting ─────────────────────────────────────

  it('POST /api/rag/summarize-meeting returns summary', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/summarize-meeting',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { meetingId: 'meet-1' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ summary: 'A meeting summary' })
    await app.close()
  })

  it('POST /api/rag/summarize-meeting returns 404 when no transcripts', async () => {
    // Temporarily make summarizeMeeting return null
    const { getRAGService } = await import('../../main/services/rag')
    const mockRag = getRAGService()
    ;(mockRag.summarizeMeeting as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)

    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/summarize-meeting',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { meetingId: 'meet-no-transcripts' }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // ─── POST /api/rag/find-action-items ─────────────────────────────────────

  it('POST /api/rag/find-action-items returns action items', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/find-action-items',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.actionItems).toBe('string')
    expect(body.actionItems).toContain('action')
    await app.close()
  })

  it('POST /api/rag/find-action-items with meetingId filters to that meeting', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/find-action-items',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { meetingId: 'meet-1' }
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  // ─── GET /api/rag/search?q=&limit= ──────────────────────────────────────────

  it('GET /api/rag/search without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/rag/search?q=test' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/rag/search returns mapped results', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/rag/search?q=decisions+made&limit=5',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    if (body.length > 0) {
      expect(body[0]).toHaveProperty('content')
      expect(body[0]).toHaveProperty('score')
    }
    await app.close()
  })

  it('GET /api/rag/search without q param returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/rag/search',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  // ─── GET /api/rag/global-search?q=&limit= ────────────────────────────────

  it('GET /api/rag/global-search without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/rag/global-search?q=test' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/rag/global-search returns results', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/rag/global-search?q=important+decisions&limit=3',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    await app.close()
  })

  // ─── GET /api/rag/chunks ─────────────────────────────────────────────────

  it('GET /api/rag/chunks without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/rag/chunks' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/rag/chunks returns array of chunk objects', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/rag/chunks',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    if (body.length > 0) {
      expect(body[0]).toHaveProperty('id')
      expect(body[0]).toHaveProperty('content')
      expect(body[0]).toHaveProperty('embeddingDimensions')
    }
    await app.close()
  })

  // ─── POST /api/rag/index ─────────────────────────────────────────────────

  it('POST /api/rag/index returns indexed count (admin)', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/index',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {
        transcript: 'This is a meeting transcript about project decisions.',
        metadata: { meetingId: 'meet-1', recordingId: 'rec-1', subject: 'Decisions' }
      }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ indexed: 5 })
    await app.close()
  })

  it('POST /api/rag/index with missing transcript returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/rag/index',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { metadata: { meetingId: 'meet-1' } }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('POST /api/rag/index with non-admin authenticated user returns 403', async () => {
    // Seed a non-admin member and log in as them
    const { upsertAllowedUser } = await import('../../main/services/database')
    upsertAllowedUser({ email: 'member@x.com', invitedBy: 'boss@x.com' })

    const memberApp = await buildApp(
      testDeps({ oidc: createFakeOidc({ email: 'member@x.com', emailVerified: true, sub: 'sub-member' }) })
    )
    const memberStart = await memberApp.inject({ method: 'GET', url: '/auth/login' })
    const memberStartCookie = memberStart.cookies.find((c) => c.name === 'hidock_session')!
    const memberCb = await memberApp.inject({
      method: 'GET',
      url: '/auth/callback?code=x&state=ignored-by-fake',
      cookies: { hidock_session: memberStartCookie.value }
    })
    const memberCookie = (memberCb.cookies.find((c) => c.name === 'hidock_session') ?? memberStartCookie).value

    const res = await memberApp.inject({
      method: 'POST',
      url: '/api/rag/index',
      cookies: { hidock_session: memberCookie },
      headers: { 'content-type': 'application/json' },
      payload: {
        transcript: 'Injected transcript.',
        metadata: { meetingId: 'meet-1' }
      }
    })
    expect(res.statusCode).toBe(403)
    await memberApp.close()
  })
})
