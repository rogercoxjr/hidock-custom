/**
 * device-sync-client.ts — streamed device-file upload client (renderer).
 *
 * Consumes a `DeviceFileSource` (SEAM 1), buffers+hashes it client-side (SHA-256 via
 * `crypto.subtle` — browsers can't hash incrementally without a userland implementation),
 * then POSTs via the two-step protocol: `postStream` create → `post` finalize.
 *
 * The device can't seek, so on any failure the WHOLE file is re-read and re-hashed from
 * `src.stream()` on the next attempt — there is no partial resume in Phase 1.
 */

import type { DeviceFileSource, DeviceFileMeta, SyncCreateResponse, SyncFinalizeResponse } from '../types-device-sync'
import type { Http } from '../http'

export interface DeviceSyncClientDeps {
  http: Http
  /** Files larger than this upload in chunks (default 64 MiB). Cloudflare and many proxies cap a
   *  single request body at ~100 MB, so large recordings must be split across requests. */
  chunkThreshold?: number
  /** Per-chunk request size for the chunked path (default 64 MiB — comfortably under ~100 MB). */
  chunkSize?: number
}

const MAX_ATTEMPTS = 2
const DEFAULT_CHUNK = 64 * 1024 * 1024 // 64 MiB — well under the ~100 MB single-request body cap

async function collectAndHash(
  src: DeviceFileSource,
  onProgress?: (sent: number) => void,
): Promise<{ blob: Blob; hashHex: string }> {
  const chunks: Uint8Array[] = []
  let sent = 0
  for await (const chunk of src.stream()) {
    // The device transfer completes at `received >= fileSize` and emits WHOLE packets,
    // so the final packet can be padded PAST the real file length (observed live: the
    // hosted /api/recordings/sync succeeds but /finalize 400s "integrity check failed"
    // because rec.bytes > declared size). Cap the collected bytes at src.size so we
    // upload EXACTLY the declared size: the finalize gate requires bytes === size, and
    // trailing padding must not be written to disk. Trimming here (before hashing) keeps
    // the client and server SHA-256 in agreement — trimming server-side would hash a
    // different byte range than the client and fail the SHA check instead.
    const remaining = src.size - sent
    if (remaining <= 0) break
    const use = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
    chunks.push(use)
    sent += use.length
    onProgress?.(sent)
  }
  // Concatenate once and hash the raw bytes directly (rather than round-tripping through
  // `Blob#arrayBuffer()`) — we already hold the chunks as Uint8Array, so this avoids relying
  // on `Blob#arrayBuffer()` support (jsdom's Blob polyfill lacks it; real browsers have it).
  const bytes = new Uint8Array(sent)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  const blob = new Blob([bytes] as BlobPart[])
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hashHex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return { blob, hashHex }
}

export function makeDeviceSyncClient({
  http,
  chunkThreshold = DEFAULT_CHUNK,
  chunkSize = DEFAULT_CHUNK,
}: DeviceSyncClientDeps) {
  return {
    async syncFile(src: DeviceFileSource, onProgress?: (sent: number) => void): Promise<SyncFinalizeResponse> {
      // A device-only recording built from cache can carry size 0 (useUnifiedRecordings:
      // `cached.file_size ?? cached.size ?? 0`). Downloading with size 0 both truncates the
      // read (downloadFile completes at `received >= 0` after the first packet) and would
      // upload a bogus file the server can't validate — reject early with a clear error
      // rather than sync a corrupt/empty recording.
      if (!(src.size > 0)) {
        throw new Error(`cannot sync ${src.filename}: unknown or zero file size`)
      }
      const meta: DeviceFileMeta = { filename: src.filename, size: src.size }
      const header = btoa(JSON.stringify(meta))
      let lastErr = 'sync failed'

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // Device can't seek → re-read the whole file each attempt.
        const { blob, hashHex } = await collectAndHash(src, onProgress)
        // Short-read guard: if the WebUSB read delivered fewer bytes than the device declared
        // (e.g. the download's transferIn was cancelled by a concurrent scan and downloadFile
        // resolved without the full file — collectAndHash then yields a truncated/empty blob),
        // do NOT upload it. Uploading a short body just makes the server reject finalize with an
        // opaque "integrity check failed"; instead fail loudly and retry (attempt 2) so a
        // transient collision self-heals and a persistent failure surfaces a clear error.
        if (blob.size !== src.size) {
          lastErr = `short read: got ${blob.size} of ${src.size} bytes`
          continue
        }
        // Upload the body: a single POST for normal files (the proven path), or a chunked
        // init → chunk×N sequence for large files. Cloudflare (and many proxies) cap a single
        // request body at ~100 MB, so a 150 MB recording must be split across sub-cap requests.
        let uploadId: string
        if (blob.size > chunkThreshold) {
          const init = await http.postStream('/api/recordings/sync/init', new Blob([]), { 'x-device-file': header })
          if (!init.ok) {
            lastErr = init.error ?? `HTTP ${init.status}`
            continue
          }
          uploadId = (init.data as { uploadId: string }).uploadId
          let chunkErr: string | null = null
          for (let offset = 0; offset < blob.size; offset += chunkSize) {
            const part = blob.slice(offset, Math.min(offset + chunkSize, blob.size))
            const res = await http.postStream(`/api/recordings/sync/${uploadId}/chunk`, part)
            onProgress?.(Math.min(offset + chunkSize, blob.size))
            if (!res.ok) {
              chunkErr = res.error ?? `HTTP ${res.status}`
              break
            }
          }
          if (chunkErr) {
            // Drop the half-written partfile server-side so it doesn't linger, then retry.
            await http.del(`/api/recordings/sync/${uploadId}`).catch(() => {})
            lastErr = chunkErr
            continue
          }
        } else {
          const created = await http.postStream('/api/recordings/sync', blob, { 'x-device-file': header })
          if (!created.ok) {
            lastErr = created.error ?? `HTTP ${created.status}`
            continue
          }
          uploadId = (created.data as SyncCreateResponse).uploadId
        }

        // The server is the authority on hash/size — its finalize 4xx surfaces as fin.ok===false.
        const fin = await http.post(`/api/recordings/sync/${uploadId}/finalize`, { clientSha256: hashHex })
        if (!fin.ok) {
          lastErr = fin.error ?? `HTTP ${fin.status}`
          continue
        }
        return fin.data as SyncFinalizeResponse
      }

      throw new Error(lastErr)
    },
  }
}

export type DeviceSyncClient = ReturnType<typeof makeDeviceSyncClient>
