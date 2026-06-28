import Fastify, { FastifyInstance } from 'fastify'
import secureSession from '@fastify/secure-session'
import websocket from '@fastify/websocket'
import multipart from '@fastify/multipart'
import { createHash } from 'crypto'
import { OidcService } from './oidc'
// Static import (unlike auth/admin) so ws.ts + broadcaster.ts share the same module instance the tests' top-level getBroadcaster() binds to after vi.resetModules(). broadcaster.ts has no side-effect imports, so loading it at parse time is safe.
import { registerWs } from './ws'
import { registerErrorHandler } from './routes/_errors'

export interface AppDeps {
  oidc: OidcService
  sessionSecret: string
  adminEmail: string
  publicUrl: string
  cookieSecure: boolean
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true })
  registerErrorHandler(app)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(secureSession as any, {
    sessionName: 'session',
    cookieName: 'hidock_session',
    key: createHash('sha256').update(deps.sessionSecret).digest(), // 32 bytes
    cookie: { path: '/', httpOnly: true, secure: deps.cookieSecure, sameSite: 'lax' }
  })
  // @fastify/websocket MUST be registered before any route so it intercepts upgrades.
  await app.register(websocket)
  // @fastify/multipart — register after websocket, before routes that need it.
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } })

  app.decorate('appDeps', deps)
  app.get('/healthz', async () => ({ status: 'ok' }))

  const { registerAuth } = await import('./auth')
  await registerAuth(app)                  // decorates requireAuth (used by /ws)

  await registerWs(app)

  const { registerAdminUsers } = await import('./routes/admin-users')
  await registerAdminUsers(app)

  const { registerRecordings } = await import('./routes/recordings')
  await registerRecordings(app)

  const { registerTranscripts } = await import('./routes/transcripts')
  await registerTranscripts(app)

  const { registerKnowledge } = await import('./routes/knowledge')
  await registerKnowledge(app)

  return app
}
