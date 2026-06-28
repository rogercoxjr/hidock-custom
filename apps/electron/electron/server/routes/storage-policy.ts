import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getRecordingById } from '../../main/services/database'
import { getStoragePolicyService } from '../../main/services/storage-policy'
import { NotFoundError, BadRequestError } from './_errors'

const STORAGE_TIERS = ['hot', 'warm', 'cold', 'archive'] as const
const QUALITY_LEVELS = ['high', 'medium', 'low'] as const

const byTierQ = z.object({
  tier: z.enum(STORAGE_TIERS)
})

const cleanupSuggestionsQ = z.object({
  tier: z.enum(STORAGE_TIERS).optional(),
  minAgeDays: z.coerce.number().int().min(0).optional()
})

const executeCleanupBody = z.object({
  ids: z.array(z.string()).min(1).max(500)
})

const assignTierBody = z.object({
  recordingId: z.string(),
  quality: z.enum(QUALITY_LEVELS)
})

export async function registerStoragePolicy(app: FastifyInstance): Promise<void> {
  const svc = getStoragePolicyService()

  // ---------------------------------------------------------------------------
  // GET /api/storage-policy/by-tier?tier=hot — recordings in a given tier
  // ---------------------------------------------------------------------------

  app.get('/api/storage-policy/by-tier', { preHandler: [app.requireAuth] }, async (req) => {
    const q = byTierQ.safeParse(req.query)
    if (!q.success) throw new BadRequestError('tier query param required (hot|warm|cold|archive)')
    return svc.getByTier(q.data.tier)
  })

  // ---------------------------------------------------------------------------
  // GET /api/storage-policy/stats — per-tier storage statistics
  // ---------------------------------------------------------------------------

  app.get('/api/storage-policy/stats', { preHandler: [app.requireAuth] }, async () => {
    return svc.getStorageStats()
  })

  // ---------------------------------------------------------------------------
  // GET /api/storage-policy/cleanup-suggestions — retention-overdue recordings
  // Optional: ?tier=hot&minAgeDays=10 to narrow to a specific tier
  // ---------------------------------------------------------------------------

  app.get('/api/storage-policy/cleanup-suggestions', { preHandler: [app.requireAuth] }, async (req) => {
    const q = cleanupSuggestionsQ.safeParse(req.query)
    if (!q.success) throw new BadRequestError('invalid query params')

    if (q.data.tier !== undefined) {
      return svc.getCleanupSuggestionsForTier(q.data.tier, q.data.minAgeDays)
    }
    return svc.getCleanupSuggestions()
  })

  // ---------------------------------------------------------------------------
  // POST /api/storage-policy/execute-cleanup — demote/delete given recording IDs
  // ---------------------------------------------------------------------------

  app.post(
    '/api/storage-policy/execute-cleanup',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const body = executeCleanupBody.parse(req.body)
      const result = await svc.executeCleanup(body.ids)
      return result
    }
  )

  // ---------------------------------------------------------------------------
  // POST /api/storage-policy/initialize-untiered — assign default tiers to
  //   recordings that have no storage_tier set yet
  // ---------------------------------------------------------------------------

  app.post(
    '/api/storage-policy/initialize-untiered',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async () => {
      const count = await svc.initializeUntieredRecordings()
      return { initialized: count }
    }
  )

  // ---------------------------------------------------------------------------
  // POST /api/storage-policy/assign-tier — manually assign tier by quality
  // ---------------------------------------------------------------------------

  app.post(
    '/api/storage-policy/assign-tier',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const body = assignTierBody.parse(req.body)
      const rec = getRecordingById(body.recordingId)
      if (!rec) throw new NotFoundError('recording not found')
      svc.assignTier(body.recordingId, body.quality)
      return { ok: true }
    }
  )
}
