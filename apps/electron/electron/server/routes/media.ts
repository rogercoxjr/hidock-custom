import { FastifyInstance } from 'fastify'
import { createReadStream, statSync } from 'fs'
import { getRecordingById } from '../../main/services/database'
import { isRecordingPathAllowed } from '../../main/services/file-storage'
import { NotFoundError, BadRequestError } from './_errors'

/**
 * Determine the MIME type from a file extension.
 * Mirrors the logic in media-protocol.ts so the REST endpoint and the
 * Electron custom scheme produce identical Content-Type headers.
 */
function mimeForPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'mp3':
    case 'hda': // HDA files are MPEG MP3
      return 'audio/mpeg'
    case 'm4a':
      return 'audio/mp4'
    case 'ogg':
      return 'audio/ogg'
    case 'flac':
      return 'audio/flac'
    case 'webm':
      return 'audio/webm'
    default:
      return 'audio/wav'
  }
}

export async function registerMedia(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/recordings/:id/media
   *
   * Streams the audio file for a recording with full HTTP Range support,
   * replacing the Electron-only hidock-media:// custom protocol for the
   * hosted hub scenario.
   *
   * Responds 206 to Range requests so the <audio> element can seek
   * without buffering the entire file (large WAVs are 200–440 MB).
   *
   * Security: the recording's file_path is validated via
   * isRecordingPathAllowed() — the same guard as the IPC file-read path —
   * so the endpoint cannot be coerced into serving arbitrary files.
   */
  app.get('/api/recordings/:id/media', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const rec = getRecordingById(id)
    if (!rec) throw new NotFoundError('recording not found')

    const filePath = rec.file_path
    if (!filePath) throw new NotFoundError('recording file not available')

    if (!isRecordingPathAllowed(filePath)) {
      throw new BadRequestError('file path not allowed')
    }

    let size: number
    try {
      size = statSync(filePath).size
    } catch {
      throw new NotFoundError('recording file not found on disk')
    }

    const contentType = mimeForPath(filePath)
    const rangeHeader = req.headers.range

    if (rangeHeader) {
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
      let start = match && match[1] ? parseInt(match[1], 10) : 0
      let end = match && match[2] ? parseInt(match[2], 10) : size - 1
      if (Number.isNaN(start)) start = 0
      if (Number.isNaN(end) || end >= size) end = size - 1

      if (start > end || start >= size) {
        return reply
          .code(416)
          .header('Content-Range', `bytes */${size}`)
          .send({ error: 'Range Not Satisfiable' })
      }

      const length = end - start + 1
      reply
        .code(206)
        .header('Content-Type', contentType)
        .header('Content-Length', String(length))
        .header('Content-Range', `bytes ${start}-${end}/${size}`)
        .header('Accept-Ranges', 'bytes')

      return reply.send(createReadStream(filePath, { start, end }))
    }

    // No Range header → full stream
    reply
      .code(200)
      .header('Content-Type', contentType)
      .header('Content-Length', String(size))
      .header('Accept-Ranges', 'bytes')

    return reply.send(createReadStream(filePath))
  })
}
