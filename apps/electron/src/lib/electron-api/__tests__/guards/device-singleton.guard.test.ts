/**
 * device-singleton.guard.test.ts — source-level guard for the device SDK group's USB ownership.
 *
 * INVARIANT: `makeDeviceGroup()` (../../groups/device.ts) MUST share the app-wide singleton
 * `JensenDevice` via `getJensenDevice()` and MUST NOT construct its own with `new JensenDevice(...)`.
 *
 * WHY (USB Device Safety — see CLAUDE.md): a second `JensenDevice` instance would independently
 * call `claimInterface(0)` on the same physical HiDock over WebUSB, double-claiming the USB device
 * and producing `LIBUSB_ERROR_ACCESS` lockups. The real connect path (pages/Device.tsx ->
 * hidock-device.ts) also uses `getJensenDevice()`, so the SDK group must reuse that single owner of
 * the USB connection rather than minting a competing one.
 *
 * A source-level assertion is intentional and appropriate here: the failure mode (a second live USB
 * claim) is a hardware lockup we must NEVER trigger from a test — so we assert against the source
 * text of the group rather than instantiating it against real or double-mocked WebUSB. Mirrors the
 * existing source-level guard in ../../../../services/__tests__/jensen-connect-filter.test.ts.
 */

import { describe, it, expect } from 'vitest'

describe('device SDK group — shared JensenDevice singleton (USB double-claim guard)', () => {
  async function readDeviceGroupSource(): Promise<string> {
    const fs = await import('fs')
    const path = await import('path')

    const sourceFile = path.join(__dirname, '..', '..', 'groups', 'device.ts')
    return fs.readFileSync(sourceFile, 'utf-8')
  }

  it('references the shared getJensenDevice() singleton accessor', async () => {
    const source = await readDeviceGroupSource()
    expect(source.includes('getJensenDevice()'), 'device.ts must obtain its JensenDevice via getJensenDevice()').toBe(
      true,
    )
  })

  it('never constructs its own JensenDevice with `new JensenDevice(` (would double-claim the USB device)', async () => {
    const source = await readDeviceGroupSource()
    expect(
      source.includes('new JensenDevice('),
      'device.ts must NOT construct a second JensenDevice — it would double-claim the USB device and lock it up',
    ).toBe(false)
  })
})
