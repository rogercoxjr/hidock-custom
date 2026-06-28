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

describe('summarization-templates endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-sumtpl-'))
    process.env.HIDOCK_DATA_ROOT = dir

    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, insertRecording } = await import(
      '../../main/services/database'
    )
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')

    // Seed a recording used for per-recording template route tests
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
  // Auth guards
  // ---------------------------------------------------------------------------

  it('GET /api/summarization-templates without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/summarization-templates' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/summarization-templates without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/summarization-templates',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'T', instructions: 'Do X' }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/summarization-templates with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/summarization-templates',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { name: 'T', instructions: 'Do X' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // ---------------------------------------------------------------------------
  // GET /api/summarization-templates
  // ---------------------------------------------------------------------------

  it('GET /api/summarization-templates returns an array (includes built-in)', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/summarization-templates',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
    await app.close()
  })

  // ---------------------------------------------------------------------------
  // POST /api/summarization-templates (create)
  // ---------------------------------------------------------------------------

  it('POST /api/summarization-templates creates a template and returns 201', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/summarization-templates',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { name: 'My Template', instructions: 'Summarize in 3 bullets.' }
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.id).toBeTruthy()
    expect(body.name).toBe('My Template')
    expect(body.instructions).toBe('Summarize in 3 bullets.')
    expect(body.isBuiltin).toBe(false)
    await app.close()
  })

  it('POST /api/summarization-templates returns 400 for missing name', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/summarization-templates',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { instructions: 'Do something' }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('POST /api/summarization-templates returns 400 for duplicate name', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // First create
    await app.inject({
      method: 'POST',
      url: '/api/summarization-templates',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Unique Name', instructions: 'Instructions.' }
    })

    // Second create with same name
    const res = await app.inject({
      method: 'POST',
      url: '/api/summarization-templates',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Unique Name', instructions: 'Other instructions.' }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  // ---------------------------------------------------------------------------
  // PATCH /api/summarization-templates/:id (update)
  // ---------------------------------------------------------------------------

  it('PATCH /api/summarization-templates/:id updates the template', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Create first
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/summarization-templates',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Original Name', instructions: 'Original instructions.' }
    })
    const { id } = createRes.json() as { id: string }

    // Patch
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/summarization-templates/${id}`,
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Updated Name' }
    })
    expect(patchRes.statusCode).toBe(200)
    expect(patchRes.json().name).toBe('Updated Name')

    await app.close()
  })

  it('PATCH /api/summarization-templates/:id with {enabled} toggles enabled flag', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/summarization-templates',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Toggle Test', instructions: 'Instructions.' }
    })
    const { id } = createRes.json() as { id: string }

    // Disable
    const disableRes = await app.inject({
      method: 'PATCH',
      url: `/api/summarization-templates/${id}`,
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { enabled: false }
    })
    expect(disableRes.statusCode).toBe(200)
    expect(disableRes.json().enabled).toBe(false)

    // Re-enable
    const enableRes = await app.inject({
      method: 'PATCH',
      url: `/api/summarization-templates/${id}`,
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { enabled: true }
    })
    expect(enableRes.statusCode).toBe(200)
    expect(enableRes.json().enabled).toBe(true)

    await app.close()
  })

  it('PATCH /api/summarization-templates/:id returns 404 for unknown id', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/summarization-templates/no-such-id',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { name: 'X' }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('PATCH /api/summarization-templates/:id without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/summarization-templates/any-id',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'X' }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('PATCH /api/summarization-templates/:id with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/summarization-templates/any-id',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { name: 'X' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // ---------------------------------------------------------------------------
  // DELETE /api/summarization-templates/:id
  // ---------------------------------------------------------------------------

  it('DELETE /api/summarization-templates/:id removes the template', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/summarization-templates',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { name: 'To Delete', instructions: 'Instructions.' }
    })
    const { id } = createRes.json() as { id: string }

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/summarization-templates/${id}`,
      cookies: { hidock_session: cookie }
    })
    expect(deleteRes.statusCode).toBe(200)
    expect(deleteRes.json()).toEqual({ ok: true })

    // Confirm gone via PATCH → 404
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/summarization-templates/${id}`,
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Anything' }
    })
    expect(patchRes.statusCode).toBe(404)

    await app.close()
  })

  it('DELETE /api/summarization-templates/:id returns 404 for unknown id', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/summarization-templates/no-such-id',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('DELETE /api/summarization-templates/:id without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/summarization-templates/any-id'
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('DELETE /api/summarization-templates/:id with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/summarization-templates/any-id',
      cookies: { hidock_session: cookie },
      headers: { origin: 'https://evil.example.com' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // ---------------------------------------------------------------------------
  // GET /api/recordings/:id/template-run
  // ---------------------------------------------------------------------------

  it('GET /api/recordings/:id/template-run without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/recordings/rec-1/template-run' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/recordings/:id/template-run returns null fields when no run exists', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-1/template-run',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.name).toBeNull()
    expect(body.confidence).toBeNull()
    expect(body.kind).toBeNull()
    expect(body.suggestedTemplate).toBeNull()
    expect(body.instructionsChanged).toBe(false)
    await app.close()
  })

  // ---------------------------------------------------------------------------
  // GET /api/recordings/:id/template-selection (previewSelection)
  // — we only test the error paths that don't hit the LLM
  // ---------------------------------------------------------------------------

  it('GET /api/recordings/:id/template-selection without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/recordings/rec-1/template-selection' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/recordings/:id/template-selection returns 404 when no transcript text', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    // rec-1 has no transcript at all
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-1/template-selection',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // ---------------------------------------------------------------------------
  // POST /api/recordings/:id/accept-suggested-template
  // — test the error paths (no transcript, no suggested run)
  // ---------------------------------------------------------------------------

  it('POST /api/recordings/:id/accept-suggested-template without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/rec-1/accept-suggested-template',
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('POST /api/recordings/:id/accept-suggested-template returns 400 when no transcript', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/rec-1/accept-suggested-template',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('POST /api/recordings/:id/accept-suggested-template returns 404 when no suggested run', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Seed a transcript with full_text
    const { upsertTranscriptStage1 } = await import('../../main/services/database')
    upsertTranscriptStage1({
      recording_id: 'rec-1',
      full_text: 'This is a test transcript with some content.',
      transcription_provider: 'test'
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/rec-1/accept-suggested-template',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: {}
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('POST /api/recordings/:id/accept-suggested-template with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/rec-1/accept-suggested-template',
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: {}
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})
