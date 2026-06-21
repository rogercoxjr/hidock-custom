/**
 * Streaming media protocol for local recordings.
 *
 * Recordings are large (often 300–450 MB WAVs). Loading them whole into the
 * renderer as base64 over IPC blocked the UI for seconds and produced a fragile
 * multi-second window where play() could be interrupted. Instead we expose a
 * privileged custom scheme that serves the file with HTTP Range support, so the
 * <audio> element streams only the bytes it needs and seeking is instant.
 *
 * URL shape: hidock-media://media/?p=<encodeURIComponent(absoluteFilePath)>
 *
 * Security: the requested path is validated against the recordings/transcripts
 * directories via the same guard used by the IPC file-read path, so the scheme
 * cannot be coerced into reading arbitrary files.
 */
import { protocol } from 'electron'
import { createReadStream, statSync } from 'fs'
import { Readable } from 'stream'
import { isRecordingPathAllowed } from './file-storage'

export const MEDIA_SCHEME = 'hidock-media'

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

/**
 * Build the renderer-side URL for a recording's absolute file path.
 * Kept here so the scheme/encoding lives in one place; the renderer has its own
 * copy (audioUtils.getMediaUrl) since it cannot import main-process modules.
 */
export function buildMediaUrl(filePath: string): string {
  return `${MEDIA_SCHEME}://media/?p=${encodeURIComponent(filePath)}`
}

/**
 * Register the streaming handler. Call once, after app `ready`.
 * (registerSchemesAsPrivileged for MEDIA_SCHEME must run before `ready`.)
 */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    let filePath = ''
    try {
      filePath = decodeURIComponent(new URL(request.url).searchParams.get('p') || '')
    } catch {
      return new Response('Bad request', { status: 400 })
    }

    if (!filePath || !isRecordingPathAllowed(filePath)) {
      return new Response('Forbidden', { status: 403 })
    }

    let size: number
    try {
      size = statSync(filePath).size
    } catch {
      return new Response('Not found', { status: 404 })
    }

    const contentType = mimeForPath(filePath)
    const rangeHeader = request.headers.get('Range')

    // Range request → 206 partial content (enables seeking without a full load).
    if (rangeHeader) {
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
      let start = match && match[1] ? parseInt(match[1], 10) : 0
      let end = match && match[2] ? parseInt(match[2], 10) : size - 1
      if (Number.isNaN(start)) start = 0
      if (Number.isNaN(end) || end >= size) end = size - 1

      if (start > end || start >= size) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}` }
        })
      }

      const nodeStream = createReadStream(filePath, { start, end })
      return new Response(Readable.toWeb(nodeStream) as unknown as ReadableStream, {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes'
        }
      })
    }

    // No range → full stream (still chunked, never buffered whole in memory).
    const nodeStream = createReadStream(filePath)
    return new Response(Readable.toWeb(nodeStream) as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes'
      }
    })
  })
}
