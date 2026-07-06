// electron/server/routes/device-sync.ts
import { FastifyInstance } from 'fastify'
import { randomUUID } from 'crypto'
import { basename } from 'path'
import { statSync, existsSync } from 'fs'
import { createPart, partPath, deletePart, sweepExpiredParts } from '../services/partfile-store'
import { isFileAlreadySynced } from '../../main/services/sync-reconcile'
import { saveRecordingFromPath } from '../../main/services/file-storage'
import { insertRecording, addToQueue } from '../../main/services/database'
import { getBroadcaster } from '../../main/services/broadcaster'
import { BadRequestError, NotFoundError } from './_errors'
import type { DeviceFileMeta } from '../../../src/lib/electron-api/types-device-sync'

// In-memory map of open uploads → their finish() result (bounded; parts are on disk).
const finished = new Map<string, { sha256: string; bytes: number; path: string; meta: DeviceFileMeta }>()

export async function registerDeviceSync(app: FastifyInstance): Promise<void> {
  // Fire a TTL sweep on registration (24h) — abandoned partfiles never accumulate.
  // Best-effort: HIDOCK_DATA_ROOT may be unset/unwritable in some environments (e.g.
  // the default '/data' outside a container), and a sweep failure must never block
  // server boot — every other route depends on registration completing.
  try {
    sweepExpiredParts(24 * 60 * 60 * 1000)
  } catch (err) {
    console.warn('[device-sync] sweepExpiredParts failed (non-fatal):', err)
  }

  // The device-sync ingest route streams raw bytes (no JSON/multipart envelope) and the
  // finalize/delete requests may omit a body/content-type entirely. Fastify 415s any
  // content type without a registered parser, so register a pass-through catch-all that
  // hands the untouched request stream straight through as req.body — the ingest handler
  // reads req.raw directly (== req.body here), and finalize/delete never read req.body
  // when there is none. Registered on the shared app instance, so it also covers the
  // "no content-type header at all" case for finalize/delete without affecting the
  // existing 'application/json'/'text/plain' parsers used by every other route.
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload))

  app.post('/api/recordings/sync', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req, reply) => {
    const header = req.headers['x-device-file']
    if (typeof header !== 'string') throw new BadRequestError('missing x-device-file header')
    let meta: DeviceFileMeta
    try {
      meta = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    } catch {
      throw new BadRequestError('bad x-device-file')
    }

    const part = createPart()
    await new Promise<void>((resolve, reject) => {
      req.raw.on('data', (c: Buffer) => part.write(c))
      req.raw.on('end', () => resolve())
      req.raw.on('error', reject)
    })
    const r = part.finish()
    finished.set(part.uploadId, { ...r, meta })
    return reply.code(200).send({ uploadId: part.uploadId, serverSha256: r.sha256, bytesReceived: r.bytes })
  })

  app.post(
    '/api/recordings/sync/:uploadId/finalize',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req, reply) => {
      const { uploadId } = req.params as { uploadId: string }
      const { clientSha256 } = (req.body ?? {}) as { clientSha256?: string }
      const rec = finished.get(uploadId)
      if (!rec) throw new NotFoundError('upload not found')

      if (!clientSha256 || clientSha256 !== rec.sha256 || rec.bytes !== rec.meta.size) {
        deletePart(uploadId)
        finished.delete(uploadId)
        throw new BadRequestError('integrity check failed')
      }

      // Reconcile: skip if already synced.
      if (isFileAlreadySynced(rec.meta.filename).synced) {
        deletePart(uploadId)
        finished.delete(uploadId)
        return reply.code(200).send({ recordingId: '', status: 'skipped' })
      }

      // Move partfile into the recordings dir (handles .hda->.wav/.mp3 + collisions).
      const storedPath = saveRecordingFromPath(rec.meta.filename, partPath(uploadId))
      finished.delete(uploadId)
      const fileSize = existsSync(storedPath) ? statSync(storedPath).size : rec.bytes

      const id = randomUUID()
      insertRecording({
        id,
        filename: basename(storedPath),
        original_filename: rec.meta.filename,
        file_path: storedPath,
        file_size: fileSize,
        duration_seconds: undefined,
        date_recorded: rec.meta.dateMs ? new Date(rec.meta.dateMs).toISOString() : new Date().toISOString(),
        meeting_id: undefined,
        correlation_confidence: undefined,
        correlation_method: undefined,
        status: 'ready',
        location: 'both',
        transcription_status: 'none',
        on_device: 1,
        device_last_seen: new Date().toISOString(),
        on_local: 1,
        source: 'hidock',
        is_imported: 0
      })
      addToQueue(id)
      getBroadcaster().broadcast('recording:new', { id })
      import('../../main/services/transcription')
        .then(({ processQueueManually }) => processQueueManually().catch(() => {}))
        .catch(() => {})

      return reply.code(200).send({ recordingId: id, status: 'synced' })
    }
  )

  app.delete(
    '/api/recordings/sync/:uploadId',
    { preHandler: [app.requireAuth, app.requireSameOrigin] },
    async (req, reply) => {
      const { uploadId } = req.params as { uploadId: string }
      deletePart(uploadId)
      finished.delete(uploadId)
      return reply.code(204).send()
    }
  )
}
