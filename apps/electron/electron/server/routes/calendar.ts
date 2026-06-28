import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getConfig, updateConfig } from '../../main/services/config'
import { syncCalendar, getLastSyncTime } from '../../main/services/calendar-sync'
import { clearAllMeetings } from '../../main/services/database'
import { BadRequestError } from './_errors'

// ─── Validation schemas ────────────────────────────────────────────────────────

const patchSettingsBody = z
  .object({
    icsUrl: z.string().url('Must be a valid URL').max(2000).optional(),
    syncEnabled: z.boolean().optional(),
    syncIntervalMinutes: z.number().int().min(1).max(1440).optional()
  })
  .refine(
    (d) => d.icsUrl !== undefined || d.syncEnabled !== undefined || d.syncIntervalMinutes !== undefined,
    { message: 'at least one field must be provided' }
  )

const syncQ = z.object({
  clear: z.coerce.number().int().min(0).max(1).optional()
})

// ─── Route registration ────────────────────────────────────────────────────────

export async function registerCalendar(app: FastifyInstance): Promise<void> {
  // GET /api/calendar/settings
  app.get('/api/calendar/settings', { preHandler: [app.requireAuth] }, async () => {
    return getConfig().calendar
  })

  // PATCH /api/calendar/settings — update icsUrl, syncEnabled, and/or syncIntervalMinutes
  app.patch(
    '/api/calendar/settings',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req) => {
      const body = patchSettingsBody.parse(req.body)
      const updates: Partial<ReturnType<typeof getConfig>['calendar']> = {}
      if (body.icsUrl !== undefined) updates.icsUrl = body.icsUrl
      if (body.syncEnabled !== undefined) updates.syncEnabled = body.syncEnabled
      if (body.syncIntervalMinutes !== undefined) updates.syncIntervalMinutes = body.syncIntervalMinutes
      await updateConfig('calendar', updates)
      return getConfig().calendar
    }
  )

  // GET /api/calendar/last-sync
  app.get('/api/calendar/last-sync', { preHandler: [app.requireAuth] }, async () => {
    return { lastSyncAt: getLastSyncTime() }
  })

  // POST /api/calendar/sync[?clear=1]
  // ?clear=1 wipes all meetings first then syncs (equivalent to calendar:clear-and-sync).
  // Without ?clear=1 it does an incremental sync (equivalent to calendar:sync).
  app.post('/api/calendar/sync', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const q = syncQ.parse(req.query)
    const config = getConfig()

    if (!config.calendar.icsUrl) {
      throw new BadRequestError('No calendar URL configured')
    }

    if (q.clear === 1) {
      clearAllMeetings()
    }

    const result = await syncCalendar(config.calendar.icsUrl)

    if (!result || typeof result.success !== 'boolean') {
      throw new BadRequestError('Sync returned an invalid result')
    }

    if (!result.success) {
      // Surface the error to the caller so the renderer can display it.
      // A failed sync is a 422 (the request was well-formed but the remote rejected it);
      // we return the structured result rather than converting it into a generic 400.
      return { ...result }
    }

    return result
  })
}
