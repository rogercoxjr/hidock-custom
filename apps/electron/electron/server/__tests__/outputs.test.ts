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

describe('outputs REST endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-outputs-'))
    process.env.HIDOCK_DATA_ROOT = dir

    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, run } = await import(
      '../../main/services/database'
    )
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')

    // Seed a knowledge capture (FK dependency for actionables + outputs)
    run(
      `INSERT INTO knowledge_captures (id, title, summary, category, status, quality_rating, storage_tier, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['kc-1', 'Alpha Meeting', 'Summary A', 'meeting', 'ready', 'valuable', 'hot', '2024-01-03T10:00:00Z']
    )

    // Seed an actionable (pending — no artifact yet)
    run(
      `INSERT INTO actionables (id, type, title, description, source_knowledge_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['act-1', 'report', 'Draft report', 'Write Q1 report', 'kc-1', 'pending',
        '2024-01-03T11:00:00Z', '2024-01-03T11:00:00Z']
    )

    // Seed an actionable with an existing output artifact
    run(
      `INSERT INTO outputs (id, knowledge_capture_id, template_id, template_name, content, generated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['out-1', 'kc-1', 'meeting_minutes', 'meeting_minutes', '# Minutes\nSome content', '2024-01-03T12:00:00Z']
    )
    run(
      `INSERT INTO actionables (id, type, title, description, source_knowledge_id, status, artifact_id, generated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['act-2', 'report', 'Done report', 'Done', 'kc-1', 'generated', 'out-1',
        '2024-01-03T12:00:00Z', '2024-01-03T11:00:00Z', '2024-01-03T12:00:00Z']
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

  // ---------------------------------------------------------------------------
  // GET /api/outputs/templates
  // ---------------------------------------------------------------------------

  it('GET /api/outputs/templates without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/outputs/templates' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/outputs/templates returns an array of templates', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/outputs/templates',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(Array.isArray(json)).toBe(true)
    expect(json.length).toBeGreaterThan(0)
    // Each template must have id, name, description, prompt
    const t = json[0]
    expect(typeof t.id).toBe('string')
    expect(typeof t.name).toBe('string')
    expect(typeof t.description).toBe('string')
    await app.close()
  })

  it('GET /api/outputs/templates includes all four built-in templates', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/outputs/templates',
      cookies: { hidock_session: cookie }
    })
    const ids: string[] = res.json().map((t: { id: string }) => t.id)
    expect(ids).toContain('meeting_minutes')
    expect(ids).toContain('interview_feedback')
    expect(ids).toContain('project_status')
    expect(ids).toContain('action_items')
    await app.close()
  })

  // ---------------------------------------------------------------------------
  // POST /api/outputs/generate
  // ---------------------------------------------------------------------------

  it('POST /api/outputs/generate without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/outputs/generate',
      headers: { 'content-type': 'application/json' },
      payload: { templateId: 'meeting_minutes', meetingId: 'meet-x' }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/outputs/generate with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/outputs/generate',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { templateId: 'meeting_minutes', meetingId: 'meet-x' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/outputs/generate with invalid templateId returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/outputs/generate',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { templateId: 'not_a_real_template', meetingId: 'meet-x' }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('POST /api/outputs/generate without any context returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/outputs/generate',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { templateId: 'meeting_minutes' }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('POST /api/outputs/generate with unknown meetingId returns 404', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/outputs/generate',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { templateId: 'meeting_minutes', meetingId: 'no-such-meeting' }
    })
    // Generator throws "Meeting not found" → NotFoundError → 404
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // ---------------------------------------------------------------------------
  // GET /api/actionables/:id/output
  // ---------------------------------------------------------------------------

  it('GET /api/actionables/:id/output without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/actionables/act-2/output' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/actionables/:id/output returns null when no output exists', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/actionables/act-1/output',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
    await app.close()
  })

  it('GET /api/actionables/:id/output returns existing output', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/actionables/act-2/output',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.content).toBe('# Minutes\nSome content')
    expect(json.templateId).toBe('meeting_minutes')
    expect(typeof json.generatedAt).toBe('string')
    await app.close()
  })

  it('GET /api/actionables/:id/output returns 404 for unknown actionable', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/actionables/no-such/output',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // ---------------------------------------------------------------------------
  // POST /api/outputs/download
  // ---------------------------------------------------------------------------

  it('POST /api/outputs/download without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/outputs/download',
      headers: { 'content-type': 'application/json' },
      payload: { content: '# Hello', filename: 'test.md' }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/outputs/download with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/outputs/download',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { content: '# Hello', filename: 'test.md' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/outputs/download returns content with Content-Disposition header', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/outputs/download',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { content: '# Meeting Minutes\n\nContent here.', filename: 'minutes.md' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toMatch(/attachment/)
    expect(res.headers['content-disposition']).toMatch(/minutes\.md/)
    expect(res.body).toBe('# Meeting Minutes\n\nContent here.')
    await app.close()
  })

  it('POST /api/outputs/download uses default filename when none provided', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/outputs/download',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { content: 'Hello world' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toMatch(/attachment/)
    expect(res.headers['content-disposition']).toMatch(/output-/)
    await app.close()
  })

  it('POST /api/outputs/download sanitises dangerous characters in filename', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/outputs/download',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { content: 'test', filename: 'out/put:file*.md' }
    })
    expect(res.statusCode).toBe(200)
    // The sanitised filename in the header should not contain path-separator or control chars.
    // (Double-quotes are valid Content-Disposition syntax; we strip the wrapper before checking.)
    const disposition = res.headers['content-disposition'] as string
    // Extract the filename value between quotes, e.g. attachment; filename="out-put-file-.md"
    const match = disposition.match(/filename="([^"]*)"/)
    expect(match).not.toBeNull()
    const sanitisedFilename = match![1]
    expect(sanitisedFilename).not.toMatch(/[/\\?%*:|<>]/)
    await app.close()
  })
})
