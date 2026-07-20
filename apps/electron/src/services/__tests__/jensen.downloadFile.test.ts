/**
 * jensen.downloadFile.test.ts — regression guard for the hosted 0-byte-download bug.
 *
 * On the shared-singleton WebUSB stack, a concurrent command (e.g. a listFiles scan) can
 * cross-resolve an in-flight download's pending promise with a foreign truthy value (a
 * FileInfo[] array) after setup()/re-claim clears currentCommandTag out from under it. The old
 * `return result ?? false` treated that array as success and returned a "downloaded" file of 0
 * bytes, which the sync client then uploaded as an empty recording. downloadFile must report
 * success ONLY when the transfer handler completed (result === true) AND the whole file arrived
 * (received >= fileSize). These tests mock sendCommand so the transfer handler never runs
 * (received stays 0), i.e. exactly the cross-resolve / abort-sweep conditions.
 */
import { describe, it, expect, vi } from 'vitest'
import { JensenDevice } from '../jensen'

function makeDev(): JensenDevice {
  const dev = new JensenDevice()
  // Bypass the `if (!this.device) return false` guard without touching real USB.
  ;(dev as unknown as { device: unknown }).device = {}
  return dev
}

describe('JensenDevice.downloadFile — success requires the full file', () => {
  it('returns false when the promise is cross-resolved with a foreign truthy value (FileInfo[])', async () => {
    const dev = makeDev()
    vi.spyOn(dev as unknown as { sendCommand: () => Promise<unknown> }, 'sendCommand').mockResolvedValue([
      { name: 'REC1.wav' },
      { name: 'REC2.wav' },
    ])
    const ok = await dev.downloadFile('20250513160405REC001.wav', 100, () => {})
    expect(ok).toBe(false)
  })

  it('returns false when resolved truthy but no bytes were received (received < fileSize)', async () => {
    const dev = makeDev()
    vi.spyOn(dev as unknown as { sendCommand: () => Promise<unknown> }, 'sendCommand').mockResolvedValue(true)
    const ok = await dev.downloadFile('20250513160405REC001.wav', 100, () => {})
    expect(ok).toBe(false)
  })

  it('returns false when the pending promise is swept to null (reset/abort)', async () => {
    const dev = makeDev()
    vi.spyOn(dev as unknown as { sendCommand: () => Promise<unknown> }, 'sendCommand').mockResolvedValue(null)
    const ok = await dev.downloadFile('20250513160405REC001.wav', 100, () => {})
    expect(ok).toBe(false)
  })
})
