import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { buildApp } from '../app'
import { createFakeOidc } from '../oidc'
import { testDeps } from './app.test'

async function makeApp() {
  return buildApp(
    testDeps({ oidc: createFakeOidc({ email: 'boss@x.com', emailVerified: true, sub: 'sub-boss' }) })
  )
}

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

const CONTACT_ID = randomUUID()
const RECORDING_ID = randomUUID()
const VP_ID_1 = randomUUID()
const VP_ID_2 = randomUUID()

describe('voiceprints REST endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-vp-'))
    process.env.HIDOCK_DATA_ROOT = dir

    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const {
      initializeDatabase,
      ensureBootstrapAdmin,
      upsertAllowedUser,
      upsertContact,
      insertRecording,
      insertVoiceprint
    } = await import('../../main/services/database')

    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')
    upsertAllowedUser({ email: 'member@x.com', role: 'member', invitedBy: 'boss@x.com' })

    // Seed a contact
    upsertContact({
      id: CONTACT_ID,
      name: 'Alice Tester',
      email: 'alice@example.com',
      type: 'unknown',
      role: null,
      company: null,
      notes: null,
      tags: null,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      meeting_count: 0,
      is_self: 0
    })

    // Seed a recording (needed for title resolution)
    insertRecording({
      id: RECORDING_ID,
      filename: 'meeting.hda',
      file_path: null,
      date_recorded: '2025-01-01T10:00:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'none',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0
    })

    // Seed two voiceprints for the contact
    insertVoiceprint({
      id: VP_ID_1,
      contact_id: CONTACT_ID,
      model_id: 'resnet-test',
      dim: 4,
      embedding: Buffer.from([0x01, 0x02, 0x03, 0x04]),
      source_recording_id: RECORDING_ID,
      source_label: 'Speaker_01',
      clean_speech_ms: 8000,
      created_from: 'confirmed'
    })
    insertVoiceprint({
      id: VP_ID_2,
      contact_id: CONTACT_ID,
      model_id: 'resnet-test',
      dim: 4,
      embedding: Buffer.from([0x05, 0x06, 0x07, 0x08]),
      source_recording_id: RECORDING_ID,
      source_label: 'Speaker_02',
      clean_speech_ms: 5000,
      created_from: 'manual'
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

  // ----------------------------------------------------------------
  // GET /api/contacts/:contactId/voiceprints — list for contact
  // ----------------------------------------------------------------

  it('GET /api/contacts/:contactId/voiceprints without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'GET',
      url: `/api/contacts/${CONTACT_ID}/voiceprints`
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/contacts/:contactId/voiceprints returns voiceprint list without embedding', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: `/api/contacts/${CONTACT_ID}/voiceprints`,
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const items = res.json() as Array<Record<string, unknown>>
    expect(items).toHaveLength(2)
    // BLOB must never be exposed
    items.forEach((vp) => {
      expect(vp).not.toHaveProperty('embedding')
      expect(vp.contactId).toBe(CONTACT_ID)
    })
    await app.close()
  })

  it('GET /api/contacts/:contactId/voiceprints returns empty array for unknown contact', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: `/api/contacts/no-such-contact/voiceprints`,
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await app.close()
  })

  // ----------------------------------------------------------------
  // GET /api/voiceprints?recordingId=&fileLabel= — find by source
  // ----------------------------------------------------------------

  it('GET /api/voiceprints without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'GET',
      url: `/api/voiceprints?recordingId=${RECORDING_ID}&fileLabel=Speaker_01`
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/voiceprints without required params returns 400', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: `/api/voiceprints`,
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('GET /api/voiceprints returns matching voiceprints', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: `/api/voiceprints?recordingId=${RECORDING_ID}&fileLabel=Speaker_01`,
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const items = res.json() as Array<Record<string, unknown>>
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(VP_ID_1)
    expect(items[0]).not.toHaveProperty('embedding')
    await app.close()
  })

  it('GET /api/voiceprints with contactId scope filters correctly', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: `/api/voiceprints?recordingId=${RECORDING_ID}&fileLabel=Speaker_01&contactId=${CONTACT_ID}`,
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const items = res.json() as Array<Record<string, unknown>>
    expect(items.every((vp) => vp.contactId === CONTACT_ID)).toBe(true)
    await app.close()
  })

  // ----------------------------------------------------------------
  // PATCH /api/voiceprints/:id  { enabled }
  // ----------------------------------------------------------------

  it('PATCH /api/voiceprints/:id without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/voiceprints/${VP_ID_1}`,
      headers: { 'content-type': 'application/json' },
      payload: { enabled: false }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('PATCH /api/voiceprints/:id with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/voiceprints/${VP_ID_1}`,
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      payload: { enabled: false }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('PATCH /api/voiceprints/:id disable then enable persists via list', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Disable
    const disableRes = await app.inject({
      method: 'PATCH',
      url: `/api/voiceprints/${VP_ID_1}`,
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { enabled: false }
    })
    expect(disableRes.statusCode).toBe(200)
    expect(disableRes.json()).toEqual({ ok: true })

    // Verify via list that disabled_at is set
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/contacts/${CONTACT_ID}/voiceprints`,
      cookies: { hidock_session: cookie }
    })
    const items = listRes.json() as Array<Record<string, unknown>>
    const vp1 = items.find((v) => v.id === VP_ID_1)
    expect(vp1?.disabledAt).toBeTruthy()

    // Re-enable
    const enableRes = await app.inject({
      method: 'PATCH',
      url: `/api/voiceprints/${VP_ID_1}`,
      cookies: { hidock_session: cookie },
      headers: { 'content-type': 'application/json' },
      payload: { enabled: true }
    })
    expect(enableRes.statusCode).toBe(200)

    // Verify disabled_at cleared
    const listRes2 = await app.inject({
      method: 'GET',
      url: `/api/contacts/${CONTACT_ID}/voiceprints`,
      cookies: { hidock_session: cookie }
    })
    const items2 = listRes2.json() as Array<Record<string, unknown>>
    const vp1After = items2.find((v) => v.id === VP_ID_1)
    expect(vp1After?.disabledAt).toBeFalsy()

    await app.close()
  })

  // ----------------------------------------------------------------
  // DELETE /api/voiceprints/:id — single hard-delete
  // ----------------------------------------------------------------

  it('DELETE /api/voiceprints/:id without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/voiceprints/${VP_ID_1}`
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('DELETE /api/voiceprints/:id with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/voiceprints/${VP_ID_1}`,
      cookies: { hidock_session: cookie },
      headers: { origin: 'https://evil.example.com' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('DELETE /api/voiceprints/:id removes the record', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/voiceprints/${VP_ID_1}`,
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    // Confirm VP_ID_1 no longer appears in list
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/contacts/${CONTACT_ID}/voiceprints`,
      cookies: { hidock_session: cookie }
    })
    const items = listRes.json() as Array<Record<string, unknown>>
    expect(items.find((v) => v.id === VP_ID_1)).toBeUndefined()
    expect(items).toHaveLength(1)

    await app.close()
  })

  // ----------------------------------------------------------------
  // DELETE /api/voiceprints?contactId= — clear all for contact
  // ----------------------------------------------------------------

  it('DELETE /api/voiceprints?contactId= without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/voiceprints?contactId=${CONTACT_ID}`
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('DELETE /api/voiceprints?contactId= with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/voiceprints?contactId=${CONTACT_ID}`,
      cookies: { hidock_session: cookie },
      headers: { origin: 'https://evil.example.com' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('DELETE /api/voiceprints?contactId= deletes all prints for a contact', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/voiceprints?contactId=${CONTACT_ID}`,
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { deleted: number }
    expect(body.deleted).toBe(2)

    // List should now be empty
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/contacts/${CONTACT_ID}/voiceprints`,
      cookies: { hidock_session: cookie }
    })
    expect(listRes.json()).toEqual([])

    await app.close()
  })

  // ----------------------------------------------------------------
  // DELETE /api/voiceprints (no params) — global clear
  // ----------------------------------------------------------------

  it('DELETE /api/voiceprints (no params) with foreign origin returns 403', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/voiceprints`,
      cookies: { hidock_session: cookie },
      headers: { origin: 'https://evil.example.com' }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('DELETE /api/voiceprints (no params) as non-admin returns 403', async () => {
    const app = await makeMemberApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/voiceprints`,
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('DELETE /api/voiceprints (no params) clears all voiceprints', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/voiceprints`,
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { deleted: number }
    expect(body.deleted).toBeGreaterThanOrEqual(2)

    // List should be empty
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/contacts/${CONTACT_ID}/voiceprints`,
      cookies: { hidock_session: cookie }
    })
    expect(listRes.json()).toEqual([])

    await app.close()
  })
})
