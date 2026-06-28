import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Fastify, { FastifyInstance } from 'fastify'
import { registerStatic } from '../static'

describe('server/static (SPA serving)', () => {
  let app: FastifyInstance
  let spaDir: string

  beforeAll(async () => {
    spaDir = mkdtempSync(join(tmpdir(), 'hidock-spa-'))
    mkdirSync(join(spaDir, 'assets'), { recursive: true })
    writeFileSync(join(spaDir, 'index.html'), '<!doctype html><title>HiDock</title><div id=root></div>')
    writeFileSync(join(spaDir, 'assets', 'app-abc123.js'), 'console.log("spa")')
    process.env.HIDOCK_SPA_DIR = spaDir

    app = Fastify()
    // Simulate a real API route registered BEFORE static, to prove precedence.
    app.get('/api/ping', async () => ({ ok: true }))
    app.get('/healthz', async () => ({ status: 'ok' }))
    await registerStatic(app)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    rmSync(spaDir, { recursive: true, force: true })
    delete process.env.HIDOCK_SPA_DIR
  })

  it('serves index.html at the root', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('id=root')
  })

  it('serves a hashed asset', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('spa')
  })

  it('falls back to index.html for an unknown client route (SPA history mode)', async () => {
    const res = await app.inject({ method: 'GET', url: '/library/some/deep/route' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('id=root')
  })

  it('does NOT shadow an API route', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ping' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
  })

  it('returns 404 JSON for an unknown /api path, not the SPA shell', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toMatch(/json/)
  })
})
