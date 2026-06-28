/**
 * Synced-files REST router (0c-3)
 *
 * Covers:
 *   GET    /api/synced-files                     — list all synced file records
 *   GET    /api/synced-files/filenames            — get all original filenames as an array
 *   GET    /api/synced-files/lookup?filename=     — lookup a single record by original filename
 *   POST   /api/synced-files                      — add / upsert a synced file record
 *   DELETE /api/synced-files?filename=            — remove a record by original filename
 *
 * IPC channels served: db:is-file-synced, db:get-synced-file, db:get-all-synced-files,
 *                       db:add-synced-file, db:remove-synced-file, db:get-synced-filenames
 */

import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  getAllSyncedFiles,
  getSyncedFilenames,
  getSyncedFile,
  addSyncedFile,
  removeSyncedFile
} from '../../main/services/database'
import { BadRequestError, NotFoundError } from './_errors'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const lookupQ = z.object({
  filename: z.string().min(1)
})

const deleteQ = z.object({
  filename: z.string().min(1)
})

const addBody = z.object({
  originalFilename: z.string().min(1),
  localFilename: z.string().min(1),
  filePath: z.string().min(1),
  fileSize: z.coerce.number().int().nonnegative().optional()
})

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function registerSyncedFiles(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------
  // GET /api/synced-files/filenames  — must be before /lookup to avoid ambiguity
  // Returns: string[]
  // IPC: db:get-synced-filenames
  // ------------------------------------------------------------------
  app.get('/api/synced-files/filenames', { preHandler: [app.requireAuth] }, async () => {
    const set = getSyncedFilenames()
    return Array.from(set)
  })

  // ------------------------------------------------------------------
  // GET /api/synced-files/lookup?filename=
  // Returns the SyncedFile row, or 404
  // IPC: db:get-synced-file, db:is-file-synced
  // ------------------------------------------------------------------
  app.get('/api/synced-files/lookup', { preHandler: [app.requireAuth] }, async (req) => {
    const q = lookupQ.safeParse(req.query)
    if (!q.success) throw new BadRequestError('filename query param required')
    const record = getSyncedFile(q.data.filename)
    if (!record) throw new NotFoundError('synced file not found')
    return record
  })

  // ------------------------------------------------------------------
  // GET /api/synced-files
  // Returns: SyncedFile[]  (ordered by synced_at DESC)
  // IPC: db:get-all-synced-files
  // ------------------------------------------------------------------
  app.get('/api/synced-files', { preHandler: [app.requireAuth] }, async () => {
    return getAllSyncedFiles()
  })

  // ------------------------------------------------------------------
  // POST /api/synced-files
  // Body: { originalFilename, localFilename, filePath, fileSize? }
  // Returns: { id }
  // IPC: db:add-synced-file
  // ------------------------------------------------------------------
  app.post('/api/synced-files', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const body = addBody.parse(req.body)
    const id = addSyncedFile(body.originalFilename, body.localFilename, body.filePath, body.fileSize)
    return { id }
  })

  // ------------------------------------------------------------------
  // DELETE /api/synced-files?filename=
  // Returns: { ok: true }
  // IPC: db:remove-synced-file
  // ------------------------------------------------------------------
  app.delete('/api/synced-files', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req) => {
    const q = deleteQ.safeParse(req.query)
    if (!q.success) throw new BadRequestError('filename query param required')
    const existing = getSyncedFile(q.data.filename)
    if (!existing) throw new NotFoundError('synced file not found')
    removeSyncedFile(q.data.filename)
    return { ok: true }
  })
}
