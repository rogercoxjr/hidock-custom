import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('startServer', () => {
  let dir: string
  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-entry-'))
    Object.assign(process.env, {
      HIDOCK_DATA_ROOT: dir, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec',
      PUBLIC_URL: 'https://hub.example.com', SESSION_SECRET: 'a-very-long-secret-value',
      ADMIN_EMAIL: 'boss@x.com', PORT: '0'
    })
  })
  afterEach(async () => {
    const { closeDatabase } = await import('../../main/services/database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
    for (const k of ['HIDOCK_DATA_ROOT','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','PUBLIC_URL','SESSION_SECRET','ADMIN_EMAIL','PORT']) delete process.env[k]
  })

  it('boots foundation, seeds the bootstrap admin, and serves /healthz', async () => {
    const { startServer } = await import('../index')
    const app = await startServer()
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    const { getAllowedUser } = await import('../../main/services/database')
    expect(getAllowedUser('boss@x.com')?.role).toBe('admin')
    await app.close()
  })
})
