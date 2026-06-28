import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getIntegrityService } from '../../main/services/integrity-service'
import { deleteWronglyNamedRecordings } from '../../main/services/file-storage'
import { clearAllSyncedFiles, queryAll, run, saveDatabase } from '../../main/services/database'
import { existsSync } from 'fs'

interface RecordingRow {
  id: string
  filename: string
  file_path: string | null
}

const repairIssueBody = z.object({
  issueId: z.string()
})

export async function registerIntegrity(app: FastifyInstance): Promise<void> {
  // GET /api/integrity/report  (admin)
  // Returns the last integrity scan report, or null if no scan has been run.
  app.get(
    '/api/integrity/report',
    { preHandler: [app.requireAuth, app.requireAdmin] },
    async () => {
      const service = getIntegrityService()
      return service.getLastReport()
    }
  )

  // POST /api/integrity/run-scan  (admin)
  // Runs a full integrity scan and returns the resulting report.
  // Progress events are broadcast over /ws as integrity:progress messages.
  app.post(
    '/api/integrity/run-scan',
    { preHandler: [app.requireAuth, app.requireAdmin, app.requireSameOrigin] },
    async () => {
      const service = getIntegrityService()
      return service.runFullScan()
    }
  )

  // POST /api/integrity/repair-issue  (admin)
  // Repairs a single auto-repairable issue by issueId.
  app.post(
    '/api/integrity/repair-issue',
    { preHandler: [app.requireAuth, app.requireAdmin, app.requireSameOrigin] },
    async (req) => {
      const { issueId } = repairIssueBody.parse(req.body)
      const service = getIntegrityService()
      return service.repairIssue(issueId)
    }
  )

  // POST /api/integrity/repair-all  (admin)
  // Repairs all auto-repairable issues from the last scan report.
  app.post(
    '/api/integrity/repair-all',
    { preHandler: [app.requireAuth, app.requireAdmin, app.requireSameOrigin] },
    async () => {
      const service = getIntegrityService()
      return service.repairAllAuto()
    }
  )

  // POST /api/integrity/run-startup-checks  (admin)
  // Runs the startup integrity checks (orphaned downloads, stuck transcriptions, file dates).
  app.post(
    '/api/integrity/run-startup-checks',
    { preHandler: [app.requireAuth, app.requireAdmin, app.requireSameOrigin] },
    async () => {
      const service = getIntegrityService()
      return service.runStartupChecks()
    }
  )

  // POST /api/integrity/cleanup-wrongly-named  (admin)
  // Deletes files with wrong naming format and clears synced_files so they can be re-downloaded.
  app.post(
    '/api/integrity/cleanup-wrongly-named',
    { preHandler: [app.requireAuth, app.requireAdmin, app.requireSameOrigin] },
    async () => {
      const fileResult = deleteWronglyNamedRecordings()
      const dbCount = clearAllSyncedFiles()
      return {
        deletedFiles: fileResult.deleted,
        keptFiles: fileResult.kept,
        clearedDbRecords: dbCount
      }
    }
  )

  // POST /api/integrity/purge-missing-files  (admin)
  // Deletes ALL recordings DB rows where the file does not exist on disk.
  app.post(
    '/api/integrity/purge-missing-files',
    { preHandler: [app.requireAuth, app.requireAdmin, app.requireSameOrigin] },
    async () => {
      const allRecordings = queryAll<RecordingRow>('SELECT id, filename, file_path FROM recordings')

      const deleted: string[] = []
      const kept: string[] = []

      for (const rec of allRecordings) {
        const hasValidPath = rec.file_path && rec.file_path.trim() !== ''
        const fileExists = hasValidPath && existsSync(rec.file_path!)

        if (!fileExists) {
          try {
            run('DELETE FROM recordings WHERE id = ?', [rec.id])
            deleted.push(rec.filename)
          } catch {
            // best-effort; keep going
          }
        } else {
          kept.push(rec.filename)
        }
      }

      if (deleted.length > 0) {
        saveDatabase()
      }

      return {
        totalRecords: allRecordings.length,
        deleted: deleted.length,
        kept: kept.length,
        deletedFiles: deleted
      }
    }
  )
}
