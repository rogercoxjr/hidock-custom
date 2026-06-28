import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getRecordingById } from '../../main/services/database'
import { getLatestDiarizationRun, getDiarizationRunsForRecording } from '../../main/services/database'
import { NotFoundError } from './_errors'

const allQ = z.object({
  all: z.coerce.number().int().min(0).max(1).optional()
})

export async function registerDiarization(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/recordings/:id/diarization
   *   ?all=1  → returns all runs for the recording (newest first)
   *   (default) → returns the single most-recent run, or null
   */
  app.get('/api/recordings/:id/diarization', { preHandler: [app.requireAuth] }, async (req) => {
    const { id } = req.params as { id: string }
    const rec = getRecordingById(id)
    if (!rec) throw new NotFoundError('recording not found')

    const q = allQ.parse(req.query)
    if (q.all === 1) {
      return getDiarizationRunsForRecording(id)
    }
    return getLatestDiarizationRun(id) ?? null
  })
}
