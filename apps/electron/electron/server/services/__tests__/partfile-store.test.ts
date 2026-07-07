// electron/server/services/__tests__/partfile-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { createPart, deletePart } from '../partfile-store'

describe('partfile-store', () => {
  let dir: string
  let savedDataRoot: string | undefined

  beforeEach(() => {
    savedDataRoot = process.env.HIDOCK_DATA_ROOT
    dir = mkdtempSync(join(tmpdir(), 'hidock-partfile-'))
    process.env.HIDOCK_DATA_ROOT = dir
  })

  afterEach(() => {
    // Restore write permission in case a test left the uploads dir locked down —
    // otherwise the recursive rmSync below can't clean it up.
    try { chmodSync(join(dir, 'uploads'), 0o700) } catch { /* dir may not exist */ }
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
    const r = await p.finish()
    const expected = createHash('sha256').update(Buffer.concat([Buffer.from(a), Buffer.from(b)])).digest('hex')
    expect(r.sha256).toBe(expected)
    expect(r.bytes).toBe(5)

    deletePart(p.uploadId)
  })

  // Server-crash finding: createPart()'s write() calls ws.write() during the
  // body-streaming phase, well before finish() is ever invoked. If the 'error'
  // listener were only attached lazily inside finish() (as it used to be), a
  // real disk error (ENOSPC/EIO) occurring during that phase would be an
  // unhandled 'error' event and crash the process. Force a real disk error
  // (EACCES, by making the uploads dir read-only) to prove the listener is
  // attached at stream-creation time: the process must not crash, and the
  // error must be observable via hasError() / a rejected finish().
  it('surfaces a real write-stream error via hasError()/finish() instead of an unhandled crash', async () => {
    const uploadsDir = join(dir, 'uploads')
    mkdirSync(uploadsDir, { recursive: true })
    chmodSync(uploadsDir, 0o500) // read+execute only — no write, so open() for a new file fails

    const p = createPart()
    p.write(new Uint8Array([1, 2, 3]))

    // The underlying WriteStream's open() failure is asynchronous. If the
    // 'error' listener were missing (the pre-fix behavior), this would throw
    // an uncaught exception here and fail/crash the test process instead of
    // reaching the assertions below.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(p.hasError()).toBeInstanceOf(Error)
    await expect(p.finish()).rejects.toBe(p.hasError())

    chmodSync(uploadsDir, 0o700)
    deletePart(p.uploadId)
  })

  // Note: we don't additionally test the narrower "error arrives while a finish()
  // call is already in flight, before ws.end()'s callback fires" ordering (the
  // `pendingReject` branch in createPart()) with a real disk error — Node's
  // fs.WriteStream has a documented-by-behavior quirk where calling .end(cb)
  // immediately after .write(), before the stream's async 'open' has resolved,
  // can invoke cb (i.e. treat the stream as "finished") before a subsequent
  // open() failure surfaces as an 'error' event, making the race non-deterministic
  // and not representative of production timing. In the real device-sync.ts flow,
  // finish() is only called after the full request body has been received over
  // the wire, by which point 'open' has long since resolved and any write error
  // is already captured by the always-attached 'error' listener before finish()
  // is ever invoked — the scenario covered by the test above.
})
