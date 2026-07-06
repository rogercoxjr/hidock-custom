// electron/server/services/__tests__/partfile-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createPart, deletePart } from '../partfile-store'
import { createHash } from 'crypto'

describe('partfile-store', () => {
  let dir: string
  let savedDataRoot: string | undefined

  beforeEach(() => {
    savedDataRoot = process.env.HIDOCK_DATA_ROOT
    dir = mkdtempSync(join(tmpdir(), 'hidock-partfile-'))
    process.env.HIDOCK_DATA_ROOT = dir
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (savedDataRoot !== undefined) {
      process.env.HIDOCK_DATA_ROOT = savedDataRoot
    } else {
      delete process.env.HIDOCK_DATA_ROOT
    }
  })

  it('hashes and sizes streamed chunks', async () => {
    const p = createPart()
    const a = new Uint8Array([1, 2, 3]); const b = new Uint8Array([4, 5])
    p.write(a); p.write(b)
    const r = p.finish()
    const expected = createHash('sha256').update(Buffer.concat([Buffer.from(a), Buffer.from(b)])).digest('hex')
    expect(r.sha256).toBe(expected)
    expect(r.bytes).toBe(5)

    // Wait a tick to ensure stream finishes before cleanup
    await new Promise((resolve) => setImmediate(resolve))
    deletePart(p.uploadId)
  })
})
