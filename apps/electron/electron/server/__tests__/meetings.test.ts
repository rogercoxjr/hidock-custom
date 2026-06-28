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

describe('meetings REST endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-meetings-'))
    process.env.HIDOCK_DATA_ROOT = dir

    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, upsertMeeting, insertRecording } = await import(
      '../../main/services/database'
    )
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')

    // Seed two meetings
    upsertMeeting({
      id: 'meet-1',
      subject: 'Weekly Sync',
      start_time: '2024-03-01T09:00:00Z',
      end_time: '2024-03-01T10:00:00Z',
      location: 'Room A',
      organizer_name: 'Alice',
      organizer_email: 'alice@x.com',
      attendees: null,
      description: 'Weekly team sync',
      is_recurring: 1,
      recurrence_rule: null,
      meeting_url: null
    })
    upsertMeeting({
      id: 'meet-2',
      subject: 'Planning',
      start_time: '2024-03-15T14:00:00Z',
      end_time: '2024-03-15T15:00:00Z',
      location: null,
      organizer_name: null,
      organizer_email: null,
      attendees: null,
      description: null,
      is_recurring: 0,
      recurrence_rule: null,
      meeting_url: null
    })

    // Seed a recording linked to meet-1
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
      meeting_id: 'meet-1',
      correlation_confidence: 0.95,
      correlation_method: 'auto'
    })
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

  // ─── Auth guard ──────────────────────────────────────────────────────────────

  it('GET /api/meetings without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/meetings' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('PATCH /api/meetings/:id without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/meetings/meet-1',
      payload: { subject: 'Updated' }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  // ─── List ────────────────────────────────────────────────────────────────────

  it('GET /api/meetings returns all meetings', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/meetings',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(Array.isArray(json)).toBe(true)
    expect(json).toHaveLength(2)
    await app.close()
  })

  it('GET /api/meetings?startDate= filters by start date', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/meetings?startDate=2024-03-10T00:00:00Z',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json).toHaveLength(1)
    expect(json[0].id).toBe('meet-2')
    await app.close()
  })

  it('GET /api/meetings?endDate= filters by end date', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/meetings?endDate=2024-03-05T00:00:00Z',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json).toHaveLength(1)
    expect(json[0].id).toBe('meet-1')
    await app.close()
  })

  // ─── Get by ID ───────────────────────────────────────────────────────────────

  it('GET /api/meetings/:id returns the meeting', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/meetings/meet-1',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.id).toBe('meet-1')
    expect(json.subject).toBe('Weekly Sync')
    await app.close()
  })

  it('GET /api/meetings/:id returns 404 for unknown id', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/meetings/does-not-exist',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // ─── By IDs (batch) ──────────────────────────────────────────────────────────

  it('POST /api/meetings/by-ids returns a map of id→meeting', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/meetings/by-ids',
      payload: { ids: ['meet-1', 'meet-2', 'unknown-id'] },
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json['meet-1'].subject).toBe('Weekly Sync')
    expect(json['meet-2'].subject).toBe('Planning')
    // unknown IDs are simply absent from the map
    expect(json['unknown-id']).toBeUndefined()
    await app.close()
  })

  it('POST /api/meetings/by-ids with empty ids returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/meetings/by-ids',
      payload: { ids: [] },
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  // ─── Details ─────────────────────────────────────────────────────────────────

  it('GET /api/meetings/:id/details returns meeting + recordings with transcripts', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/meetings/meet-1/details',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.meeting.id).toBe('meet-1')
    expect(Array.isArray(json.recordings)).toBe(true)
    expect(json.recordings).toHaveLength(1)
    expect(json.recordings[0].id).toBe('rec-1')
    expect('transcript' in json.recordings[0]).toBe(true)
    await app.close()
  })

  it('GET /api/meetings/:id/details returns 404 for unknown meeting', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/meetings/no-such-meeting/details',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // ─── Update (PATCH) ──────────────────────────────────────────────────────────

  it('PATCH /api/meetings/:id updates the subject and returns the updated meeting', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/meetings/meet-1',
      payload: { subject: 'Updated Weekly Sync' },
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.subject).toBe('Updated Weekly Sync')
    await app.close()
  })

  it('PATCH /api/meetings/:id with no fields returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/meetings/meet-1',
      payload: {},
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('PATCH /api/meetings/:id returns 404 for unknown meeting', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/meetings/no-such/patch',
      payload: { subject: 'X' },
      cookies: { hidock_session: cookie }
    })
    // /api/meetings/no-such/patch doesn't match /:id — returns 404 (route not found)
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('PATCH /api/meetings/:id without same-origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/meetings/meet-1',
      payload: { subject: 'X' },
      cookies: { hidock_session: cookie },
      headers: { origin: 'https://attacker.com' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // ─── Recordings for meeting ───────────────────────────────────────────────────

  it('GET /api/meetings/:id/recordings returns recordings linked to the meeting', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/meetings/meet-1/recordings',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(Array.isArray(json)).toBe(true)
    expect(json).toHaveLength(1)
    expect(json[0].id).toBe('rec-1')
    await app.close()
  })

  it('GET /api/meetings/:id/recordings returns empty array for meeting with no recordings', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/meetings/meet-2/recordings',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json).toHaveLength(0)
    await app.close()
  })

  it('GET /api/meetings/:id/recordings returns 404 for unknown meeting', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/meetings/no-such-meeting/recordings',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
