import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getRecordingById } from '../../main/services/database'
import { getQualityAssessmentService } from '../../main/services/quality-assessment'
import { NotFoundError } from './_errors'

const QUALITY_LEVELS = ['high', 'medium', 'low'] as const
type QualityLevel = (typeof QUALITY_LEVELS)[number]

const putQualityBody = z.object({
  quality: z.enum(QUALITY_LEVELS),
  reason: z.string().max(1000).optional(),
  assessedBy: z.string().max(200).optional()
})

const batchAssessBody = z.object({
  ids: z.array(z.string()).min(1).max(500)
})

export async function registerQuality(app: FastifyInstance): Promise<void> {
  const svc = getQualityAssessmentService()

  // -------------------------------------------------------------------
  // Per-recording quality
  // -------------------------------------------------------------------

  app.get('/api/recordings/:id/quality', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    const rec = getRecordingById(id)
    if (!rec) throw new NotFoundError('recording not found')
    const assessment = svc.getQuality(id)
    return assessment ?? null
  })

  app.put(
    '/api/recordings/:id/quality',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id } = req.params as { id: string }
      const rec = getRecordingById(id)
      if (!rec) throw new NotFoundError('recording not found')
      const body = putQualityBody.parse(req.body)
      const assessment = await svc.assessQuality(
        id,
        body.quality as QualityLevel,
        body.reason,
        body.assessedBy
      )
      return assessment
    }
  )

  app.post(
    '/api/recordings/:id/quality/auto-assess',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { id } = req.params as { id: string }
      const rec = getRecordingById(id)
      if (!rec) throw new NotFoundError('recording not found')
      const assessment = await svc.autoAssess(id)
      return assessment
    }
  )

  // -------------------------------------------------------------------
  // Collection-level quality actions
  // -------------------------------------------------------------------

  app.post(
    '/api/quality/batch-assess',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const { ids } = batchAssessBody.parse(req.body)
      const assessments = await svc.batchAutoAssess(ids)
      return { assessed: assessments.length, items: assessments }
    }
  )

  app.post(
    '/api/quality/assess-unassessed',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async () => {
      const count = await svc.assessUnassessed()
      return { assessed: count }
    }
  )
}
