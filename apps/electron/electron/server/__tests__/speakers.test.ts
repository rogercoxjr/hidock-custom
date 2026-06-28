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

describe('speakers REST endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-speakers-'))
    process.env.HIDOCK_DATA_ROOT = dir

    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, insertRecording, upsertContact } = await import(
      '../../main/services/database'
    )
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')

    const now = new Date().toISOString()

    // Seed a recording
    insertRecording({
      id: 'rec-1',
      filename: 'rec1.hda',
      file_path: null,
      date_recorded: '2024-01-03T10:00:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'none',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0
    })

    // Seed two contacts
    upsertContact({
      id: 'contact-1',
      name: 'Alice Smith',
      email: 'alice@example.com',
      type: 'team',
      role: null,
      company: null,
      notes: null,
      tags: null,
      first_seen_at: now,
      last_seen_at: now,
      meeting_count: 0,
      is_self: 0
    })
    upsertContact({
      id: 'contact-2',
      name: 'Bob Jones',
      email: 'bob@example.com',
      type: 'external',
      role: null,
      company: null,
      notes: null,
      tags: null,
      first_seen_at: now,
      last_seen_at: now,
      meeting_count: 0,
      is_self: 0
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

  // -------------------------------------------------------------------------
  // GET /api/recordings/:id/speakers — 401 without auth
  // -------------------------------------------------------------------------

  it('GET /api/recordings/:id/speakers without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/recordings/rec-1/speakers' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  // -------------------------------------------------------------------------
  // GET — not-found
  // -------------------------------------------------------------------------

  it('GET /api/recordings/:id/speakers returns 404 for unknown recording', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/no-such/speakers',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // -------------------------------------------------------------------------
  // GET — empty roster
  // -------------------------------------------------------------------------

  it('GET /api/recordings/:id/speakers returns empty object when no assignments', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-1/speakers',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({})
    await app.close()
  })

  // -------------------------------------------------------------------------
  // PUT — assign a speaker
  // -------------------------------------------------------------------------

  it('PUT /api/recordings/:id/speakers/:fileLabel without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'PUT',
      url: '/api/recordings/rec-1/speakers/A',
      headers: { 'content-type': 'application/json' },
      payload: { contactId: 'contact-1' }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('PUT /api/recordings/:id/speakers/:fileLabel with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PUT',
      url: '/api/recordings/rec-1/speakers/A',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { contactId: 'contact-1' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('PUT /api/recordings/:id/speakers/:fileLabel assigns contact and is reflected in GET', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/recordings/rec-1/speakers/A',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { contactId: 'contact-1' }
    })
    expect(putRes.statusCode).toBe(200)
    expect(putRes.json()).toMatchObject({ recordingId: 'rec-1', fileLabel: 'A', contactId: 'contact-1' })

    // Verify persistence via GET
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-1/speakers',
      cookies: { hidock_session: cookie }
    })
    expect(getRes.statusCode).toBe(200)
    expect(getRes.json()).toMatchObject({ A: { contactId: 'contact-1', contactName: 'Alice Smith' } })

    await app.close()
  })

  it('PUT /api/recordings/:id/speakers/:fileLabel returns 404 for unknown recording', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PUT',
      url: '/api/recordings/no-such/speakers/A',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { contactId: 'contact-1' }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('PUT /api/recordings/:id/speakers/:fileLabel returns 404 for unknown contact', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PUT',
      url: '/api/recordings/rec-1/speakers/A',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { contactId: 'no-such-contact' }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // -------------------------------------------------------------------------
  // DELETE — unassign a speaker
  // -------------------------------------------------------------------------

  it('DELETE /api/recordings/:id/speakers/:fileLabel without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'DELETE', url: '/api/recordings/rec-1/speakers/A' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('DELETE /api/recordings/:id/speakers/:fileLabel unassigns and GET returns empty', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Assign first
    await app.inject({
      method: 'PUT',
      url: '/api/recordings/rec-1/speakers/A',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { contactId: 'contact-1' }
    })

    // Then delete
    const delRes = await app.inject({
      method: 'DELETE',
      url: '/api/recordings/rec-1/speakers/A',
      cookies: { hidock_session: cookie }
    })
    expect(delRes.statusCode).toBe(200)
    expect(delRes.json()).toMatchObject({ recordingId: 'rec-1', fileLabel: 'A' })

    // GET confirms removal
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-1/speakers',
      cookies: { hidock_session: cookie }
    })
    expect(getRes.json()).toEqual({})

    await app.close()
  })

  // -------------------------------------------------------------------------
  // POST merge — requires a transcript with turns in the DB
  // -------------------------------------------------------------------------

  it('POST /api/recordings/:id/speakers/merge without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/rec-1/speakers/merge',
      headers: { 'content-type': 'application/json' },
      payload: { fromLabel: 'A', toLabel: 'B' }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/recordings/:id/speakers/merge returns 404 when no diarized turns', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/rec-1/speakers/merge',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { fromLabel: 'A', toLabel: 'B' }
    })
    // No transcript inserted → parseTurns returns [] → 404
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('POST /api/recordings/:id/speakers/merge returns 400 when fromLabel === toLabel', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/rec-1/speakers/merge',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { fromLabel: 'A', toLabel: 'A' }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('POST /api/recordings/:id/speakers/merge rewrites turns and roster', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Seed a transcript with turns
    const { upsertTranscriptStage1 } = await import('../../main/services/database')
    upsertTranscriptStage1({
      recording_id: 'rec-1',
      full_text: 'Hello World Bye',
      transcription_provider: 'test',
      turns: [
        { speaker: 'A', startMs: 0, endMs: 1000, text: 'Hello' },
        { speaker: 'B', startMs: 1000, endMs: 2000, text: 'World' },
        { speaker: 'A', startMs: 2000, endMs: 3000, text: 'Bye' }
      ]
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/rec-1/speakers/merge',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { fromLabel: 'A', toLabel: 'B' }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.fromLabel).toBe('A')
    expect(body.toLabel).toBe('B')
    // All turns should now be 'B'
    const speakers: string[] = body.turns.map((t: { speaker: string }) => t.speaker)
    expect(speakers.every((s) => s === 'B')).toBe(true)

    await app.close()
  })

  // -------------------------------------------------------------------------
  // POST set-self
  // -------------------------------------------------------------------------

  it('POST /api/recordings/:id/speakers/:fileLabel/set-self without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/rec-1/speakers/A/set-self'
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/recordings/:id/speakers/:fileLabel/set-self returns needsSelfContact when no self', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/rec-1/speakers/A/set-self',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ selfAssigned: false, needsSelfContact: true })
    await app.close()
  })

  it('POST /api/recordings/:id/speakers/:fileLabel/set-self assigns when self contact exists', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Create and mark the self contact
    const { upsertContact, setSelfContact } = await import('../../main/services/database')
    const now = new Date().toISOString()
    upsertContact({
      id: 'contact-self',
      name: 'Me',
      email: 'me@example.com',
      type: 'team',
      role: null,
      company: null,
      notes: null,
      tags: null,
      first_seen_at: now,
      last_seen_at: now,
      meeting_count: 0,
      is_self: 0
    })
    setSelfContact('contact-self')

    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/rec-1/speakers/A/set-self',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ selfAssigned: true, contactId: 'contact-self' })
    await app.close()
  })

  // -------------------------------------------------------------------------
  // GET speaker-suggestions (no voiceprints seeded — should return [])
  // -------------------------------------------------------------------------

  it('GET /api/recordings/:id/speaker-suggestions without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/recordings/rec-1/speaker-suggestions' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/recordings/:id/speaker-suggestions returns 404 for unknown recording', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/no-such/speaker-suggestions',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('GET /api/recordings/:id/speaker-suggestions returns array (empty when no voiceprints)', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-1/speaker-suggestions',
      cookies: { hidock_session: cookie }
    })
    // Matcher will fail/return [] since no voiceprints exist — handler catches and returns []
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
    await app.close()
  })

  // -------------------------------------------------------------------------
  // POST suggestion dismiss / accept
  // -------------------------------------------------------------------------

  it('POST /api/speaker-suggestions/:id/dismiss without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/speaker-suggestions/some-suggestion-id/dismiss'
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/speaker-suggestions/:id/dismiss with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/speaker-suggestions/some-suggestion-id/dismiss',
      cookies: { hidock_session: cookie },
      headers: { origin: 'https://evil.example.com' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('POST /api/speaker-suggestions/:id/dismiss returns ok for non-existent id (idempotent)', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/speaker-suggestions/no-such-suggestion/dismiss',
      cookies: { hidock_session: cookie }
    })
    // dismiss is an UPDATE — it's a no-op if the row doesn't exist; we just return ok
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: 'no-such-suggestion' })
    await app.close()
  })

  it('POST /api/speaker-suggestions/:id/accept returns ok for non-existent id (idempotent)', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/speaker-suggestions/no-such-suggestion/accept',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: 'no-such-suggestion' })
    await app.close()
  })

  it('POST /api/speaker-suggestions/:id/dismiss persists dismissal in DB', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Seed a suggestion
    const { insertSuggestion, getPendingSuggestions } = await import('../../main/services/database')
    insertSuggestion({
      id: 'sug-1',
      recording_id: 'rec-1',
      transcript_id: null,
      diarization_run_id: 'run-1',
      kind: 'identity',
      target_label: 'A',
      target_label_2: null,
      contact_id: 'contact-1',
      contact_id_2: null,
      score: 0.9,
      rank: 1,
      rationale: 'test',
      status: 'pending'
    })

    // Confirm it's pending
    const before = getPendingSuggestions('rec-1')
    expect(before.some((s) => s.id === 'sug-1')).toBe(true)

    // Dismiss
    await app.inject({
      method: 'POST',
      url: '/api/speaker-suggestions/sug-1/dismiss',
      cookies: { hidock_session: cookie }
    })

    // Confirm it's no longer pending
    const after = getPendingSuggestions('rec-1')
    expect(after.some((s) => s.id === 'sug-1')).toBe(false)

    await app.close()
  })
})
