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

describe('projects REST endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-projects-'))
    process.env.HIDOCK_DATA_ROOT = dir

    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, createProject, upsertMeeting } = await import(
      '../../main/services/database'
    )
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')

    // Seed two projects
    createProject({ id: 'proj-1', name: 'Project Alpha', description: 'First project', status: 'active' })
    createProject({ id: 'proj-2', name: 'Project Beta', description: null, status: 'archived' })

    // Seed a meeting for tagging tests
    upsertMeeting({
      id: 'meet-1',
      subject: 'Planning Session',
      start_time: '2024-05-01T09:00:00Z',
      end_time: '2024-05-01T10:00:00Z',
      location: null,
      organizer_name: null,
      organizer_email: null,
      attendees: null,
      description: null,
      is_recurring: 0,
      recurrence_rule: null,
      meeting_url: null
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

  // ─── Auth guard ───────────────────────────────────────────────────────────────

  it('GET /api/projects without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/projects without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'X' }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  // ─── Same-origin guard on write ───────────────────────────────────────────────

  it('POST /api/projects with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { name: 'Evil Project' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // ─── List ─────────────────────────────────────────────────────────────────────

  it('GET /api/projects returns all projects with total', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.total).toBe(2)
    expect(json.items).toHaveLength(2)
    await app.close()
  })

  it('GET /api/projects?status=active filters by status', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects?status=active',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.items.every((p: { status: string }) => p.status === 'active')).toBe(true)
    await app.close()
  })

  it('GET /api/projects?search= filters by name', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects?search=Alpha',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.total).toBe(1)
    expect(json.items[0].name).toBe('Project Alpha')
    await app.close()
  })

  it('GET /api/projects paginates with limit/offset', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects?limit=1&offset=0',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.total).toBe(2)
    expect(json.items).toHaveLength(1)
    await app.close()
  })

  // ─── Get by ID ────────────────────────────────────────────────────────────────

  it('GET /api/projects/:id returns the project with meetings and topics', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/proj-1',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.project.id).toBe('proj-1')
    expect(json.project.name).toBe('Project Alpha')
    expect(Array.isArray(json.meetings)).toBe(true)
    expect(Array.isArray(json.topics)).toBe(true)
    expect(Array.isArray(json.project.knowledgeIds)).toBe(true)
    expect(Array.isArray(json.project.personIds)).toBe(true)
    await app.close()
  })

  it('GET /api/projects/:id returns 404 for unknown id', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/does-not-exist',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // ─── Create ───────────────────────────────────────────────────────────────────

  it('POST /api/projects creates a project and returns 201', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { name: 'New Project', description: 'A fresh one' }
    })
    expect(res.statusCode).toBe(201)
    const json = res.json()
    expect(typeof json.id).toBe('string')
    expect(json.name).toBe('New Project')
    expect(json.description).toBe('A fresh one')
    expect(json.status).toBe('active')
    await app.close()
  })

  it('POST /api/projects without name returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { description: 'No name here' }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('POST /api/projects persists — verifiable via GET', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Persist Me' }
    })
    const created = createRes.json()

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/projects/${created.id}`,
      cookies: { hidock_session: cookie }
    })
    expect(getRes.statusCode).toBe(200)
    expect(getRes.json().project.name).toBe('Persist Me')
    await app.close()
  })

  // ─── Update ───────────────────────────────────────────────────────────────────

  it('PATCH /api/projects/:id updates name and returns updated project', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/projects/proj-1',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Alpha Renamed' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Alpha Renamed')
    await app.close()
  })

  it('PATCH /api/projects/:id updates status to archived', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/projects/proj-1',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { status: 'archived' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('archived')
    await app.close()
  })

  it('PATCH /api/projects/:id returns 404 for unknown id', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/projects/no-such',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { name: 'X' }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('PATCH /api/projects/:id without same-origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/projects/proj-1',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://attacker.com' },
      payload: { name: 'X' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // ─── Delete ───────────────────────────────────────────────────────────────────

  it('DELETE /api/projects/:id returns ok:true', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/projects/proj-2',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })

  it('DELETE /api/projects/:id then GET returns 404', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    await app.inject({
      method: 'DELETE',
      url: '/api/projects/proj-2',
      cookies: { hidock_session: cookie }
    })

    const getRes = await app.inject({
      method: 'GET',
      url: '/api/projects/proj-2',
      cookies: { hidock_session: cookie }
    })
    expect(getRes.statusCode).toBe(404)
    await app.close()
  })

  it('DELETE /api/projects/:id returns 404 for unknown id', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/projects/no-such-id',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // ─── Tag / untag meeting ──────────────────────────────────────────────────────

  it('POST /api/meetings/:meetingId/projects/:projectId tags the meeting', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/meetings/meet-1/projects/proj-1',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })

  it('POST /api/meetings/:meetingId/projects/:projectId returns 404 for unknown meeting', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/meetings/no-such-meeting/projects/proj-1',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('POST /api/meetings/:meetingId/projects/:projectId returns 404 for unknown project', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/meetings/meet-1/projects/no-such-project',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('DELETE /api/meetings/:meetingId/projects/:projectId untags the meeting', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Tag first
    await app.inject({
      method: 'POST',
      url: '/api/meetings/meet-1/projects/proj-1',
      cookies: { hidock_session: cookie }
    })

    // Untag
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/meetings/meet-1/projects/proj-1',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })

  it('DELETE /api/meetings/:meetingId/projects/:projectId without same-origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/meetings/meet-1/projects/proj-1',
      cookies: { hidock_session: cookie },
      headers: { origin: 'https://evil.example.com' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // ─── Projects for meeting ─────────────────────────────────────────────────────

  it('GET /api/meetings/:meetingId/projects returns tagged projects', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Tag proj-1 to meet-1
    await app.inject({
      method: 'POST',
      url: '/api/meetings/meet-1/projects/proj-1',
      cookies: { hidock_session: cookie }
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/meetings/meet-1/projects',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(Array.isArray(json)).toBe(true)
    expect(json).toHaveLength(1)
    expect(json[0].id).toBe('proj-1')
    await app.close()
  })

  it('GET /api/meetings/:meetingId/projects returns empty array when no tags', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/meetings/meet-1/projects',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(0)
    await app.close()
  })

  it('GET /api/meetings/:meetingId/projects returns 404 for unknown meeting', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/meetings/no-such-meeting/projects',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
