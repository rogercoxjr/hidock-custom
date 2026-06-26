import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { registerErrorHandler } from '../routes/_errors'
import { NotFoundError, BadRequestError, ConflictError } from '../routes/_errors'
import { z } from 'zod'

function appWithRoutes() {
  const app = Fastify()
  registerErrorHandler(app)
  app.get('/nf', async () => { throw new NotFoundError('nope') })
  app.get('/br', async () => { throw new BadRequestError('bad') })
  app.get('/cf', async () => { throw new ConflictError('dup') })
  app.get('/zod', async () => { z.object({ a: z.string() }).parse({}); return {} })
  app.get('/boom', async () => { throw new Error('secret detail') })
  app.get('/ok', async () => ({ value: 1 }))
  return app
}

describe('REST error envelope', () => {
  it('maps typed errors + zod to status + {error}', async () => {
    const app = appWithRoutes()
    expect((await app.inject({ url: '/nf' })).statusCode).toBe(404)
    expect((await app.inject({ url: '/br' })).statusCode).toBe(400)
    expect((await app.inject({ url: '/cf' })).statusCode).toBe(409)
    expect((await app.inject({ url: '/zod' })).statusCode).toBe(400)
    const ok = await app.inject({ url: '/ok' }); expect(ok.statusCode).toBe(200); expect(ok.json()).toEqual({ value: 1 })
    await app.close()
  })
  it('maps unexpected throws to 500 without leaking the message', async () => {
    const app = appWithRoutes()
    const res = await app.inject({ url: '/boom' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'internal' })
    expect(JSON.stringify(res.json())).not.toContain('secret detail')
    await app.close()
  })
  it('does NOT leak the message of a non-HttpError that carries a statusCode', async () => {
    const app = appWithRoutes()
    app.get('/statusy', async () => { const e: any = new Error('postgres://user:secret@host/db'); e.statusCode = 503; throw e })
    const res = await app.inject({ url: '/statusy' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'internal' })
    expect(JSON.stringify(res.json())).not.toContain('secret')
    await app.close()
  })
})
