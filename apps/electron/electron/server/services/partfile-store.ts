// electron/server/services/partfile-store.ts
import { createHash, randomUUID } from 'crypto'
import { createWriteStream, mkdirSync, existsSync, rmSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

function partsDir(): string {
  const root = process.env.HIDOCK_DATA_ROOT || '/data'
  const dir = join(root, 'uploads')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function createPart(): {
  uploadId: string
  write: (chunk: Uint8Array) => void
  hasError: () => Error | null
  finish: () => Promise<{ sha256: string; bytes: number; path: string }>
} {
  const uploadId = randomUUID()
  const path = join(partsDir(), `${uploadId}.part`)
  const ws = createWriteStream(path)
  const hash = createHash('sha256')
  let bytes = 0

  // Attach the 'error' listener immediately at stream creation — NOT lazily inside
  // finish(). Writes happen during the body-streaming phase (see device-sync.ts),
  // well before finish() is ever called; without a listener from the start, a
  // mid-stream disk error (ENOSPC/EIO) would emit an unhandled 'error' event and
  // crash the process. Capture the error here and surface it via finish()/hasError()
  // instead, plus reject any finish() call already in flight when the stream errors
  // out mid-.end().
  let writeError: Error | null = null
  let pendingReject: ((err: Error) => void) | null = null
  ws.on('error', (err) => {
    writeError = err
    if (pendingReject) { pendingReject(err); pendingReject = null }
  })

  return {
    uploadId,
    write(chunk) { hash.update(chunk); bytes += chunk.length; ws.write(Buffer.from(chunk)) },
    hasError() { return writeError },
    finish() {
      return new Promise((resolve, reject) => {
        if (writeError) return reject(writeError)
        pendingReject = reject
        ws.end(() => {
          pendingReject = null
          if (writeError) return reject(writeError)
          resolve({ sha256: hash.digest('hex'), bytes, path })
        })
      })
    },
  }
}

export function partPath(uploadId: string): string {
  return join(partsDir(), `${uploadId}.part`)
}

export function deletePart(uploadId: string): void {
  const p = partPath(uploadId)
  if (existsSync(p)) rmSync(p, { force: true })
}

export function sweepExpiredParts(maxAgeMs: number): number {
  const dir = partsDir()
  let removed = 0
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.part')) continue
    const full = join(dir, f)
    if (Date.now() - statSync(full).mtimeMs > maxAgeMs) { rmSync(full, { force: true }); removed++ }
  }
  return removed
}
