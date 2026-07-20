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

// In-progress CHUNKED uploads: the partfile stays open across requests (init → chunk×N →
// finalize). Large recordings can't go in a single POST because Cloudflare (and many proxies)
// cap a single request body at ~100 MB; the client streams them as sub-cap chunks appended to
// one partfile, and finalize closes/hashes it exactly like the single-shot path.
const open = new Map<string, { part: ReturnType<typeof createPart>; meta: DeviceFileMeta }>()

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
  // when there is none. Registered on an encapsulated child plugin scoped to just these
  // three routes, so it doesn't affect the 'application/json'/'text/plain' parsers (or the
  // default 415) used by every other route on the shared app instance. requireAuth/
  // requireSameOrigin decorators still propagate into the child scope via Fastify's
  // prototypal inheritance, so the preHandlers below keep working unchanged.
  await app.register(async (scoped) => {
    scoped.addContentTypeParser('*', (_req, payload, done) => done(null, payload))

    scoped.post(
      '/api/recordings/sync',
      { preHandler: [scoped.requireAuth, scoped.requireSameOrigin] },
      async (req, reply) => {
        const header = req.headers['x-device-file']
        if (typeof header !== 'string') throw new BadRequestError('missing x-device-file header')
        let meta: DeviceFileMeta
        try {
          meta = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
        } catch {
          throw new BadRequestError('bad x-device-file')
        }

        const part = createPart()
        try {
          await new Promise<void>((resolve, reject) => {
            req.raw.on('data', (c: Buffer) => {
              part.write(c)
              // Fail fast: don't wait for the full body if the partfile write has
              // already errored (e.g. ENOSPC/EIO) — no point draining the rest of
              // the upload. part.finish() would also reject on this, but bailing
              // here avoids buffering a possibly-large remaining body first.
              const err = part.hasError()
              if (err) reject(err)
            })
            req.raw.on('end', () => resolve())
            req.raw.on('error', reject)
          })
          const r = await part.finish()
          finished.set(part.uploadId, { ...r, meta })
          return reply.code(200).send({ uploadId: part.uploadId, serverSha256: r.sha256, bytesReceived: r.bytes })
        } catch (err) {
          // A disk error mid-upload must become a handled 5xx + partfile cleanup,
          // never an unhandled crash — see partfile-store.ts's 'error' listener.
          deletePart(part.uploadId)
          throw err
        }
      }
    )

    // --- Chunked upload (large files) ---------------------------------------------------------
    // init: open a partfile (no body) and return its uploadId; the client then POSTs the file
    // in sub-cap chunks to /chunk and closes it with the shared /finalize.
    scoped.post(
      '/api/recordings/sync/init',
      { preHandler: [scoped.requireAuth, scoped.requireSameOrigin] },
      async (req, reply) => {
        const header = req.headers['x-device-file']
        if (typeof header !== 'string') throw new BadRequestError('missing x-device-file header')
        let meta: DeviceFileMeta
        try {
          meta = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
        } catch {
          throw new BadRequestError('bad x-device-file')
        }
        const part = createPart()
        open.set(part.uploadId, { part, meta })
        return reply.code(200).send({ uploadId: part.uploadId })
      }
    )

    // chunk: append one raw-byte chunk to an open partfile (drains req.raw like /sync, but does
    // not finish — finalize does that once all chunks are in).
    scoped.post(
      '/api/recordings/sync/:uploadId/chunk',
      { preHandler: [scoped.requireAuth, scoped.requireSameOrigin] },
      async (req, reply) => {
        const { uploadId } = req.params as { uploadId: string }
        const o = open.get(uploadId)
        if (!o) throw new NotFoundError('upload not found')
        try {
          await new Promise<void>((resolve, reject) => {
            req.raw.on('data', (c: Buffer) => {
              o.part.write(c)
              const err = o.part.hasError()
              if (err) reject(err)
            })
            req.raw.on('end', () => resolve())
            req.raw.on('error', reject)
          })
        } catch (err) {
          // A disk error mid-chunk aborts the whole upload: close+drop the partfile.
          open.delete(uploadId)
          deletePart(uploadId)
          throw err
        }
        return reply.code(200).send({ ok: true })
      }
    )

    scoped.post(
      '/api/recordings/sync/:uploadId/finalize',
      { preHandler: [scoped.requireAuth, scoped.requireSameOrigin] },
      async (req, reply) => {
        const { uploadId } = req.params as { uploadId: string }
        const { clientSha256 } = (req.body ?? {}) as { clientSha256?: string }
        // Source the completed upload from either the single-shot /sync path (already finished)
        // or a chunked upload (finish the open partfile now to get its hash + byte count).
        let rec = finished.get(uploadId)
        if (!rec) {
          const o = open.get(uploadId)
          if (o) {
            open.delete(uploadId)
            const r = await o.part.finish()
            rec = { ...r, meta: o.meta }
          }
        }
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

    scoped.delete(
      '/api/recordings/sync/:uploadId',
      { preHandler: [scoped.requireAuth, scoped.requireSameOrigin] },
      async (req, reply) => {
        const { uploadId } = req.params as { uploadId: string }
        // Close an in-progress chunked upload's write stream before deleting its file.
        const o = open.get(uploadId)
        if (o) {
          open.delete(uploadId)
          await o.part.finish().catch(() => {})
        }
        deletePart(uploadId)
        finished.delete(uploadId)
        return reply.code(204).send()
      }
    )
  })
}
