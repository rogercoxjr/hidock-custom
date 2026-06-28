import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getConfig, saveConfig } from '../../main/services/config'
import { BadRequestError } from './_errors'

const keyQ = z.object({
  key: z.string().optional()
})

// The PATCH body accepts an arbitrary partial of AppConfig.
// We do not exhaustively enumerate every nested field here — the config service
// uses deepMerge so any valid partial will be applied correctly.  The only
// validation we enforce at the REST layer is that the body is a plain object.
const patchBody = z.record(z.string(), z.unknown())

export async function registerConfig(app: FastifyInstance): Promise<void> {
  // GET /api/config          → full AppConfig
  // GET /api/config?key=foo  → AppConfig[key]
  app.get('/api/config', { preHandler: [app.requireAuth, app.requireAdmin] }, async (req) => {
    const q = keyQ.parse(req.query)
    const cfg = getConfig()
    if (q.key !== undefined) {
      if (!(q.key in cfg)) throw new BadRequestError(`unknown config key: ${q.key}`)
      return { key: q.key, value: (cfg as unknown as Record<string, unknown>)[q.key] }
    }
    return cfg
  })

  // PATCH /api/config  → merge partial AppConfig, return updated config (admin only)
  app.patch(
    '/api/config',
    { preHandler: [app.requireAuth, app.requireAdmin, app.requireSameOrigin] },
    async (req) => {
      const body = patchBody.parse(req.body)
      if (typeof body !== 'object' || Array.isArray(body)) {
        throw new BadRequestError('body must be a plain object')
      }
      await saveConfig(body as Parameters<typeof saveConfig>[0])
      return getConfig()
    }
  )
}
