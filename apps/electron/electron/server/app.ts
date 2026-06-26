import Fastify, { FastifyInstance } from 'fastify'
import secureSession from '@fastify/secure-session'
import websocket from '@fastify/websocket'
import { createHash } from 'crypto'
import { OidcService } from './oidc'
import { registerWs } from './ws'

export interface AppDeps {
  oidc: OidcService
  sessionSecret: string
  adminEmail: string
  publicUrl: string
  cookieSecure: boolean
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(secureSession as any, {
    sessionName: 'session',
    cookieName: 'hidock_session',
    key: createHash('sha256').update(deps.sessionSecret).digest(), // 32 bytes
    cookie: { path: '/', httpOnly: true, secure: deps.cookieSecure, sameSite: 'lax' }
  })
  // @fastify/websocket MUST be registered before any route so it intercepts upgrades.
  await app.register(websocket)

  app.decorate('appDeps', deps)
  app.get('/healthz', async () => ({ status: 'ok' }))

  const { registerAuth } = await import('./auth')
  await registerAuth(app)                  // decorates requireAuth (used by /ws)

  await registerWs(app)

  const { registerAdminUsers } = await import('./routes/admin-users')
  await registerAdminUsers(app)

  return app
}
