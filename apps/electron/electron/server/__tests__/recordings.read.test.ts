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

describe('recordings read endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-rec-read-'))
    process.env.HIDOCK_DATA_ROOT = dir
    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, insertRecording } = await import(
      '../../main/services/database'
    )
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')

    // Seed 3 recordings
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
    insertRecording({
      id: 'rec-2',
      filename: 'rec2.hda',
      file_path: null,
      date_recorded: '2024-01-02T10:00:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'none',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0
    })
    insertRecording({
      id: 'rec-3',
      filename: 'rec3.hda',
      file_path: null,
      date_recorded: '2024-01-01T10:00:00Z',
      status: 'pending',
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

  it('GET /api/recordings without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/recordings' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/recordings returns paginated list with total', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings?limit=2&offset=0',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().total).toBe(3)
    expect(res.json().items).toHaveLength(2)
    await app.close()
  })

  it('GET /api/recordings?status=ready filters by status', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings?status=ready',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.items.every((x: { status: string }) => x.status === 'ready')).toBe(true)
    await app.close()
  })

  it('GET /api/recordings/:id returns 404 for unknown id', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/does-not-exist',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('GET /api/recordings/:id returns the recording', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-1',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().id).toBe('rec-1')
    await app.close()
  })

  it('GET /api/recordings/with-transcripts returns items with transcript field', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/with-transcripts',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.total).toBe(3)
    expect(json.items).toHaveLength(3)
    // Each item should have a transcript field (may be null/undefined)
    json.items.forEach((item: Record<string, unknown>) => {
      expect('transcript' in item).toBe(true)
    })
    await app.close()
  })
})
