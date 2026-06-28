import { FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * Resolve the built SPA directory.
 * - HIDOCK_SPA_DIR overrides (set in the Docker image).
 * - Otherwise resolve <serverBundleDir>/../renderer (out/server -> out/renderer).
 */
function resolveSpaDir(): string {
  if (process.env.HIDOCK_SPA_DIR) return process.env.HIDOCK_SPA_DIR
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'renderer')
}

/**
 * Serve the built SPA from the same Fastify instance as the API.
 * MUST be registered AFTER all /api, /ws, /healthz, and auth routes so those win.
 * Unknown non-API GETs fall back to index.html (client-side history routing);
 * unknown /api paths return Fastify's JSON 404 (handled by the notFound logic).
 */
export async function registerStatic(app: FastifyInstance): Promise<void> {
  const root = resolveSpaDir()
  if (!existsSync(join(root, 'index.html'))) {
    app.log?.warn?.(`[static] SPA not found at ${root}; serving API only`)
    return
  }

  await app.register(fastifyStatic, { root, prefix: '/', wildcard: false })

  // SPA history fallback: any GET that didn't match an API route or a real file
  // returns index.html — EXCEPT /api/* and /ws, which must 404/handle normally.
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      reply.code(404).type('application/json').send({ error: 'Not Found', path: req.url })
      return
    }
    reply.sendFile('index.html', root)
  })
}
