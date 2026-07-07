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
}

const MAX_ATTEMPTS = 2

async function collectAndHash(
  src: DeviceFileSource,
  onProgress?: (sent: number) => void,
): Promise<{ blob: Blob; hashHex: string }> {
  const chunks: Uint8Array[] = []
  let sent = 0
  for await (const chunk of src.stream()) {
    chunks.push(chunk)
    sent += chunk.length
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

export function makeDeviceSyncClient({ http }: DeviceSyncClientDeps) {
  return {
    async syncFile(src: DeviceFileSource, onProgress?: (sent: number) => void): Promise<SyncFinalizeResponse> {
      const meta: DeviceFileMeta = { filename: src.filename, size: src.size }
      const header = btoa(JSON.stringify(meta))
      let lastErr = 'sync failed'

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // Device can't seek → re-read the whole file each attempt.
        const { blob, hashHex } = await collectAndHash(src, onProgress)
        const created = await http.postStream('/api/recordings/sync', blob, { 'x-device-file': header })
        if (!created.ok) {
          lastErr = created.error ?? `HTTP ${created.status}`
          continue
        }
        // Server reports the hash it computed while receiving the stream; the client sends its
        // own `clientSha256` on finalize and the server is the authority on rejecting a mismatch
        // (its 4xx response surfaces as `fin.ok === false` below), so we don't duplicate that
        // check client-side here.
        const { uploadId } = created.data as SyncCreateResponse
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
