// electron/server/services/__tests__/partfile-store.test.ts
import { describe, it, expect } from 'vitest'
import { createPart, deletePart } from '../partfile-store'
import { createHash } from 'crypto'

describe('partfile-store', () => {
  it('hashes and sizes streamed chunks', () => {
    const p = createPart()
    const a = new Uint8Array([1, 2, 3]); const b = new Uint8Array([4, 5])
    p.write(a); p.write(b)
    const r = p.finish()
    const expected = createHash('sha256').update(Buffer.concat([Buffer.from(a), Buffer.from(b)])).digest('hex')
    expect(r.sha256).toBe(expected)
    expect(r.bytes).toBe(5)
    deletePart(p.uploadId)
  })
})
