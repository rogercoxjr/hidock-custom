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

describe('contacts REST endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-contacts-'))
    process.env.HIDOCK_DATA_ROOT = dir

    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, upsertContact, upsertMeeting } = await import(
      '../../main/services/database'
    )
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')

    const now = new Date().toISOString()

    // Seed two contacts
    upsertContact({
      id: 'contact-1',
      name: 'Alice Smith',
      email: 'alice@example.com',
      type: 'team',
      role: 'Engineer',
      company: 'Acme',
      notes: null,
      tags: null,
      first_seen_at: now,
      last_seen_at: now,
      meeting_count: 3,
      is_self: 0
    })
    upsertContact({
      id: 'contact-2',
      name: 'Bob Jones',
      email: 'bob@example.com',
      type: 'external',
      role: null,
      company: 'Other Corp',
      notes: null,
      tags: JSON.stringify(['vip']),
      first_seen_at: now,
      last_seen_at: now,
      meeting_count: 1,
      is_self: 0
    })

    // Seed a meeting for the for-meeting test
    upsertMeeting({
      id: 'meet-1',
      subject: 'Contacts Test Meeting',
      start_time: '2024-01-10T09:00:00Z',
      end_time: '2024-01-10T10:00:00Z',
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

  it('GET /api/contacts without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/contacts' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  // ─── List ─────────────────────────────────────────────────────────────────────

  it('GET /api/contacts returns paginated list with total', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'GET',
      url: '/api/contacts?limit=10&offset=0',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.total).toBe('number')
    expect(body.total).toBeGreaterThanOrEqual(2)
    expect(Array.isArray(body.items)).toBe(true)
    await app.close()
  })

  it('GET /api/contacts?type=team filters by type', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'GET',
      url: '/api/contacts?type=team',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items.every((c: { type: string }) => c.type === 'team')).toBe(true)
    await app.close()
  })

  it('GET /api/contacts?search=alice filters by name/email', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'GET',
      url: '/api/contacts?search=alice',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items.length).toBeGreaterThanOrEqual(1)
    expect(body.items.some((c: { name: string }) => c.name === 'Alice Smith')).toBe(true)
    await app.close()
  })

  // ─── GetById ──────────────────────────────────────────────────────────────────

  it('GET /api/contacts/:id returns contact with meetings', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'GET',
      url: '/api/contacts/contact-1',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.contact.id).toBe('contact-1')
    expect(body.contact.name).toBe('Alice Smith')
    expect(Array.isArray(body.meetings)).toBe(true)
    expect(typeof body.totalMeetingTimeMinutes).toBe('number')
    await app.close()
  })

  it('GET /api/contacts/:id returns 404 for unknown id', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'GET',
      url: '/api/contacts/does-not-exist',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // ─── Create ───────────────────────────────────────────────────────────────────

  it('POST /api/contacts creates a new contact (201)', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'POST',
      url: '/api/contacts',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Carol White', email: 'carol@example.com', type: 'customer' }
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.name).toBe('Carol White')
    expect(body.email).toBe('carol@example.com')
    expect(body.type).toBe('customer')
    expect(typeof body.id).toBe('string')
    await app.close()
  })

  it('POST /api/contacts without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/contacts',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Carol White' }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/contacts with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'POST',
      url: '/api/contacts',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { name: 'Attacker' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // ─── Update ───────────────────────────────────────────────────────────────────

  it('PATCH /api/contacts/:id updates fields and persists', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/contacts/contact-1',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { role: 'Senior Engineer', tags: ['key-person'] }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.role).toBe('Senior Engineer')
    expect(Array.isArray(body.tags)).toBe(true)
    expect(body.tags).toContain('key-person')

    // Verify persistence with re-GET
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/contacts/contact-1',
      cookies: { hidock_session: cookie }
    })
    expect(getRes.json().contact.role).toBe('Senior Engineer')
    await app.close()
  })

  it('PATCH /api/contacts/:id returns 404 for unknown id', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/contacts/no-such-id',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { role: 'Anything' }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // ─── Delete ───────────────────────────────────────────────────────────────────

  it('DELETE /api/contacts/:id returns ok:true', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/contacts/contact-2',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })

  it('DELETE /api/contacts/:id then GET returns 404', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    await app.inject({
      method: 'DELETE',
      url: '/api/contacts/contact-2',
      cookies: { hidock_session: cookie }
    })
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/contacts/contact-2',
      cookies: { hidock_session: cookie }
    })
    expect(getRes.statusCode).toBe(404)
    await app.close()
  })

  it('DELETE /api/contacts/:id returns 404 for unknown id', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/contacts/no-such-id',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // ─── For-meeting ──────────────────────────────────────────────────────────────

  it('GET /api/meetings/:id/contacts returns array', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'GET',
      url: '/api/meetings/meet-1/contacts',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
    await app.close()
  })

  it('GET /api/meetings/:id/contacts returns 404 for unknown meeting', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'GET',
      url: '/api/meetings/no-such-meeting/contacts',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // ─── Self ─────────────────────────────────────────────────────────────────────

  it('GET /api/contacts/self returns null when no self set', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'GET',
      url: '/api/contacts/self',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
    await app.close()
  })

  it('PUT /api/contacts/self sets the self contact', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'PUT',
      url: '/api/contacts/self',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { contactId: 'contact-1' }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.id).toBe('contact-1')

    // Verify GET /api/contacts/self now returns the contact
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/contacts/self',
      cookies: { hidock_session: cookie }
    })
    expect(getRes.statusCode).toBe(200)
    expect(getRes.json().id).toBe('contact-1')
    await app.close()
  })

  it('PUT /api/contacts/self with null clears the self contact', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Set self first
    await app.inject({
      method: 'PUT',
      url: '/api/contacts/self',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { contactId: 'contact-1' }
    })

    // Clear self
    const res = await app.inject({
      method: 'PUT',
      url: '/api/contacts/self',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { contactId: null }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()

    // Verify cleared
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/contacts/self',
      cookies: { hidock_session: cookie }
    })
    expect(getRes.json()).toBeNull()
    await app.close()
  })

  it('PUT /api/contacts/self with unknown contactId returns 404', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'PUT',
      url: '/api/contacts/self',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { contactId: 'does-not-exist' }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
