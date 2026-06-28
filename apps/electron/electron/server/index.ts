import { FastifyInstance } from 'fastify'
import { bootFoundation } from '../main/boot-foundation'
import { ensureBootstrapAdmin } from '../main/services/database'
import { getConfig, updateConfig } from '../main/services/config'
import { getServerConfig } from './config'
import { createGoogleOidc } from './oidc'
import { buildApp } from './app'

/**
 * Apply container-env overrides onto the on-disk config after the foundation
 * boots. Today the only one is OLLAMA_URL: inside a container the config default
 * http://localhost:11434 points at the container itself, so the operator sets
 * OLLAMA_URL to the host/sibling Ollama. We write it into config.embeddings
 * (the RAG/embedding Ollama endpoint) so the existing embedding code — which
 * reads config, not env — picks it up. Idempotent: skips the write if unchanged.
 */
export async function applyEnvOverrides(): Promise<void> {
  const ollama = process.env.OLLAMA_URL
  if (ollama && getConfig().embeddings.ollamaBaseUrl !== ollama) {
    await updateConfig('embeddings', { ollamaBaseUrl: ollama })
  }
}

export async function startServer(): Promise<FastifyInstance> {
  const cfg = getServerConfig()
  await bootFoundation()
  await applyEnvOverrides()
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
