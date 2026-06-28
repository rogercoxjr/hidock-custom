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

describe('actionables REST endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-actionables-'))
    process.env.HIDOCK_DATA_ROOT = dir

    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, run, upsertMeeting, insertRecording } = await import(
      '../../main/services/database'
    )
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')

    // Seed a knowledge capture (FK dependency for actionables)
    run(
      `INSERT INTO knowledge_captures (id, title, summary, category, status, quality_rating, storage_tier, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['kc-1', 'Alpha', 'Summary A', 'meeting', 'ready', 'valuable', 'hot', '2024-01-03T10:00:00Z']
    )

    // Seed a meeting + recording linked to it (for by-meeting tests)
    upsertMeeting({
      id: 'meet-1',
      subject: 'Weekly Sync',
      start_time: '2024-03-01T09:00:00Z',
      end_time: '2024-03-01T10:00:00Z',
      location: null,
      organizer_name: null,
      organizer_email: null,
      attendees: null,
      description: null,
      is_recurring: 0,
      recurrence_rule: null,
      meeting_url: null
    })
    insertRecording({
      id: 'rec-1',
      filename: 'rec1.hda',
      file_path: null,
      date_recorded: '2024-03-01T09:05:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'none',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0,
      meeting_id: 'meet-1'
    })

    // Link knowledge capture to the meeting via source_recording_id
    run(
      `UPDATE knowledge_captures SET source_recording_id = ?, meeting_id = ? WHERE id = ?`,
      ['rec-1', 'meet-1', 'kc-1']
    )

    // Seed 3 actionables
    run(
      `INSERT INTO actionables (id, type, title, description, source_knowledge_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['act-1', 'email', 'Send follow-up', 'Follow up with team', 'kc-1', 'pending',
        '2024-01-03T11:00:00Z', '2024-01-03T11:00:00Z']
    )
    run(
      `INSERT INTO actionables (id, type, title, description, source_knowledge_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['act-2', 'report', 'Draft report', 'Write Q1 report', 'kc-1', 'generated',
        '2024-01-03T12:00:00Z', '2024-01-03T12:00:00Z']
    )
    run(
      `INSERT INTO actionables (id, type, title, description, source_knowledge_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['act-3', 'task', 'Create ticket', null, 'kc-1', 'dismissed',
        '2024-01-03T13:00:00Z', '2024-01-03T13:00:00Z']
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
  // GET /api/actionables
  // ---------------------------------------------------------------------------

  it('GET /api/actionables without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/actionables' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/actionables returns paginated list with total', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/actionables?limit=2&offset=0',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.total).toBe(3)
    expect(json.items).toHaveLength(2)
    await app.close()
  })

  it('GET /api/actionables?status=pending filters by status', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/actionables?status=pending',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.total).toBe(1)
    expect(json.items[0].id).toBe('act-1')
    await app.close()
  })

  it('GET /api/actionables?status= with unknown status value returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/actionables?status=bogus_status',
      cookies: { hidock_session: cookie }
    })
    // Unknown status values must produce 400, not a vacuous 200 empty list
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('GET /api/actionables items have camelCase fields', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/actionables',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const item = res.json().items[0]
    expect('sourceKnowledgeId' in item).toBe(true)
    expect('suggestedRecipients' in item).toBe(true)
    await app.close()
  })

  // ---------------------------------------------------------------------------
  // GET /api/meetings/:id/actionables
  // ---------------------------------------------------------------------------

  it('GET /api/meetings/:id/actionables without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/meetings/meet-1/actionables' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/meetings/:id/actionables returns actionables for that meeting', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/meetings/meet-1/actionables',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(Array.isArray(json)).toBe(true)
    expect(json).toHaveLength(3)
    await app.close()
  })

  it('GET /api/meetings/:id/actionables returns empty array for unknown meeting', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/meetings/no-such-meeting/actionables',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await app.close()
  })

  // ---------------------------------------------------------------------------
  // PATCH /api/actionables/:id
  // ---------------------------------------------------------------------------

  it('PATCH /api/actionables/:id without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/actionables/act-1',
      headers: { 'content-type': 'application/json' },
      payload: { status: 'in_progress' }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('PATCH /api/actionables/:id with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/actionables/act-1',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { status: 'in_progress' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('PATCH /api/actionables/:id returns 404 for unknown id', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/actionables/does-not-exist',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { status: 'in_progress' }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('PATCH /api/actionables/:id performs a valid status transition', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/actionables/act-1',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { status: 'in_progress' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('in_progress')
    await app.close()
  })

  it('PATCH /api/actionables/:id rejects an invalid status transition with 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    // act-1 is 'pending'; 'shared' is not a valid transition from pending
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/actionables/act-1',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { status: 'shared' }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  // ---------------------------------------------------------------------------
  // POST /api/actionables/:id/generate-output
  // ---------------------------------------------------------------------------

  it('POST /api/actionables/:id/generate-output without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/actionables/act-1/generate-output',
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/actionables/:id/generate-output with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/actionables/act-1/generate-output',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: {}
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/actionables/:id/generate-output returns 404 for unknown id', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/actionables/no-such/generate-output',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('POST /api/actionables/:id/generate-output transitions pending → in_progress', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/actionables/act-1/generate-output',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.actionableId).toBe('act-1')
    expect(json.sourceKnowledgeId).toBe('kc-1')
    // Verify DB state
    const { queryAll: qa } = await import('../../main/services/database')
    const row = qa<{ status: string }>('SELECT status FROM actionables WHERE id = ?', ['act-1'])[0]
    expect(row.status).toBe('in_progress')
    await app.close()
  })

  it('POST /api/actionables/:id/generate-output also accepts generated status', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/actionables/act-2/generate-output',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().actionableId).toBe('act-2')
    await app.close()
  })

  it('POST /api/actionables/:id/generate-output rejects dismissed status with 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/actionables/act-3/generate-output',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})
