import { FastifyInstance } from 'fastify'
import {
  getMigrationStatusImpl,
  generateCleanupPreviewImpl,
  runPreMigrationCleanupImpl,
  migrateToV11Impl,
  rollbackV11MigrationImpl
} from '../../main/ipc/migration-handlers'
import { ConflictError } from './_errors'

export async function registerMigration(app: FastifyInstance): Promise<void> {
  // GET /api/migration/status  (admin)
  // Returns migration status counts: pending / migrated / skipped / total.
  app.get(
    '/api/migration/status',
    { preHandler: [app.requireAuth, app.requireAdmin] },
    async () => {
      return getMigrationStatusImpl()
    }
  )

  // GET /api/migration/preview  (admin)
  // Returns a preview of data that would be affected by pre-migration cleanup.
  app.get(
    '/api/migration/preview',
    { preHandler: [app.requireAuth, app.requireAdmin] },
    async () => {
      return generateCleanupPreviewImpl()
    }
  )

  // POST /api/migration/run-cleanup  (admin)
  // Runs the pre-migration cleanup (orphaned transcripts, duplicates, bad meeting refs).
  // Progress emitted over /ws as migration:progress events.
  app.post(
    '/api/migration/run-cleanup',
    { preHandler: [app.requireAuth, app.requireAdmin, app.requireSameOrigin] },
    async () => {
      return runPreMigrationCleanupImpl()
    }
  )

  // POST /api/migration/run-v11  (admin)
  // Executes the v11 knowledge-captures migration. Acquires an advisory lock —
  // returns 409 if another migration is already in progress.
  // Progress emitted over /ws as migration:progress events.
  app.post(
    '/api/migration/run-v11',
    { preHandler: [app.requireAuth, app.requireAdmin, app.requireSameOrigin] },
    async () => {
      const result = await migrateToV11Impl()
      if (!result.success && result.errors.some((e) => e.includes('already in progress'))) {
        throw new ConflictError('migration already in progress')
      }
      return result
    }
  )

  // POST /api/migration/rollback-v11  (admin)
  // Rolls back the v11 migration, restoring from backup. Returns 409 if migration is in progress.
  // Progress emitted over /ws as migration:progress events.
  app.post(
    '/api/migration/rollback-v11',
    { preHandler: [app.requireAuth, app.requireAdmin, app.requireSameOrigin] },
    async () => {
      const result = await rollbackV11MigrationImpl()
      if (!result.success && result.errors.some((e) => e.includes('in progress'))) {
        throw new ConflictError('migration in progress, cannot rollback')
      }
      return result
    }
  )
}
