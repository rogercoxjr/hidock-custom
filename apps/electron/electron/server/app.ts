import Fastify, { FastifyInstance } from 'fastify'
import secureSession from '@fastify/secure-session'
import { createHash } from 'crypto'
import { OidcService } from './oidc'

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

  app.decorate('appDeps', deps)
  app.get('/healthz', async () => ({ status: 'ok' }))

  const { registerAuth } = await import('./auth')
  await registerAuth(app)

  const { registerAdminUsers } = await import('./routes/admin-users')
  await registerAdminUsers(app)

  return app
}
