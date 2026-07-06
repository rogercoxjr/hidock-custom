import { describe, it, expect } from 'vitest'
import { buildJensenListFrames, buildJensenFileFrames } from '../__mocks__/webusb-mock'
import { parseJensenStream } from '../jensen' // export a pure parser (Step 3b)

describe('webusb-mock conformance', () => {
  it('list frames parse back through the real parser', () => {
    const files = [{ filename: 'REC001.hda', bytes: new Uint8Array([1, 2, 3]) }]
    const msgs = parseJensenStream(buildJensenListFrames(files))
    expect(msgs.some((m) => m.cmdId === 4)).toBe(true)
  })

  it('file frames reassemble to the original bytes', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256)
    const msgs = parseJensenStream(buildJensenFileFrames(bytes))
    const body = msgs.filter((m) => m.cmdId === 5).flatMap((m) => [...m.body])
    expect(new Uint8Array(body)).toEqual(bytes)
  })
})
