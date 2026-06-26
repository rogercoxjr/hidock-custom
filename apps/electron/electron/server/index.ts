import { FastifyInstance } from 'fastify'
import { bootFoundation } from '../main/boot-foundation'
import { ensureBootstrapAdmin } from '../main/services/database'
import { getServerConfig } from './config'
import { createGoogleOidc } from './oidc'
import { buildApp } from './app'

export async function startServer(): Promise<FastifyInstance> {
  const cfg = getServerConfig()
  await bootFoundation()
  ensureBootstrapAdmin(cfg.adminEmail)
  const oidc = createGoogleOidc({ clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret, publicUrl: cfg.publicUrl })
  const app = await buildApp({
    oidc, sessionSecret: cfg.sessionSecret, adminEmail: cfg.adminEmail,
    publicUrl: cfg.publicUrl, cookieSecure: true
  })
  await app.listen({ port: cfg.port, host: '0.0.0.0' })
  return app
}

// Run when invoked directly (node out/server/index.js).
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  startServer().catch((err) => { console.error('[server] failed to start', err); process.exit(1) })
}
