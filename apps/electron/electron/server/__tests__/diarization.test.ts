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

describe('diarization endpoints', () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-diar-'))
    process.env.HIDOCK_DATA_ROOT = dir

    const { initializeFileStorage } = await import('../../main/services/file-storage')
    const { initializeDatabase, ensureBootstrapAdmin, insertRecording, insertDiarizationRun } = await import(
      '../../main/services/database'
    )
    await initializeFileStorage()
    await initializeDatabase()
    ensureBootstrapAdmin('boss@x.com')

    insertRecording({
      id: 'rec-1',
      filename: 'rec1.hda',
      file_path: null,
      date_recorded: '2024-01-01T10:00:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'none',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0
    })

    // Insert two diarization runs for rec-1 (older first, newer second)
    insertDiarizationRun({
      id: 'run-old',
      recording_id: 'rec-1',
      provider: 'google',
      model: 'chirp3',
      options_min: 1,
      options_max: 5,
      label_count: 2,
      is_solo: 0,
      created_at: '2024-01-01T11:00:00Z'
    })
    insertDiarizationRun({
      id: 'run-new',
      recording_id: 'rec-1',
      provider: 'google',
      model: 'chirp3',
      options_min: 2,
      options_max: 6,
      label_count: 3,
      is_solo: 0,
      created_at: '2024-01-01T12:00:00Z'
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

  it('GET /api/recordings/:id/diarization without auth returns 401', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/api/recordings/rec-1/diarization' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('GET /api/recordings/:id/diarization returns 404 for unknown recording', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/no-such-rec/diarization',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('GET /api/recordings/:id/diarization returns the latest run', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-1/diarization',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const run = res.json()
    // Should be the newest run
    expect(run.id).toBe('run-new')
    expect(run.label_count).toBe(3)
    await app.close()
  })

  it('GET /api/recordings/:id/diarization?all=1 returns all runs newest first', async () => {
    const app = await makeApp()
    const cookie = await login(app)
    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-1/diarization?all=1',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    const runs = res.json()
    expect(Array.isArray(runs)).toBe(true)
    expect(runs).toHaveLength(2)
    // Newest first
    expect(runs[0].id).toBe('run-new')
    expect(runs[1].id).toBe('run-old')
    await app.close()
  })

  it('GET /api/recordings/:id/diarization returns null for recording with no runs', async () => {
    const app = await makeApp()
    const cookie = await login(app)

    // Insert a recording with no diarization runs
    const { insertRecording } = await import('../../main/services/database')
    insertRecording({
      id: 'rec-nodiar',
      filename: 'rec-nodiar.hda',
      file_path: null,
      date_recorded: '2024-02-01T10:00:00Z',
      status: 'ready',
      location: 'device-only',
      transcription_status: 'none',
      on_device: 1,
      on_local: 0,
      source: 'hidock',
      is_imported: 0
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/recordings/rec-nodiar/diarization',
      cookies: { hidock_session: cookie }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
    await app.close()
  })
})
