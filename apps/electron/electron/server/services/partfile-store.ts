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
  finish: () => Promise<{ sha256: string; bytes: number; path: string }>
} {
  const uploadId = randomUUID()
  const path = join(partsDir(), `${uploadId}.part`)
  const ws = createWriteStream(path)
  const hash = createHash('sha256')
  let bytes = 0
  return {
    uploadId,
    write(chunk) { hash.update(chunk); bytes += chunk.length; ws.write(Buffer.from(chunk)) },
    finish() {
      return new Promise((resolve, reject) => {
        ws.on('error', reject)
        ws.end(() => resolve({ sha256: hash.digest('hex'), bytes, path }))
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
