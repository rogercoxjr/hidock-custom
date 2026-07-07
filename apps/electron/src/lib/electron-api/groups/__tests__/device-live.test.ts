/**
 * device-live.test.ts — mock-backed integration test proving `makeDeviceGroup()` delegates to a
 * real `JensenDevice` instance instead of rejecting with the Phase-1 stub marker.
 *
 * Uses the shared WebUSB mock (Task 2, `src/services/__mocks__/webusb-mock.ts`) — never real
 * hardware. Per CLAUDE.md USB safety rules, all USB code here is mock-backed only.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeDeviceGroup } from '../device'
import { makeMockUsbDevice } from '../../../../services/__mocks__/webusb-mock'

afterEach(() => {
  vi.unstubAllGlobals()
})

// Real device filenames encode a capture date/time (see JensenDevice.parseFilenameDateTime);
// listFiles() filters out entries whose name doesn't parse to a date, so the fixture below
// uses the "YYYYMMDDHHMMSSREC..." format documented there instead of a bare 'REC001.hda'.
const FILENAME = '20250513160405REC001.wav'

it('lists files from a mocked device', async () => {
  const mockDev = makeMockUsbDevice([{ filename: FILENAME, bytes: new Uint8Array([1, 2, 3]) }])
  vi.stubGlobal('navigator', {
    usb: {
      requestDevice: vi.fn().mockResolvedValue(mockDev),
      getDevices: vi.fn().mockResolvedValue([]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  })
  const grp = makeDeviceGroup()
  await grp.jensen.connect()
  const files = await grp.jensen.listFiles()
  expect(files?.[0]?.name).toBe(FILENAME)
  await grp.jensen.disconnect()
})

describe('downloadService.deviceFileSource', () => {
  it('streams a downloaded file to completion without hanging', async () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50])
    const mockDev = makeMockUsbDevice([{ filename: FILENAME, bytes }])
    vi.stubGlobal('navigator', {
      usb: {
        requestDevice: vi.fn().mockResolvedValue(mockDev),
        getDevices: vi.fn().mockResolvedValue([]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    })
    const grp = makeDeviceGroup()
    await grp.jensen.connect()

    const src = grp.downloadService.deviceFileSource(FILENAME, bytes.length)
    const received: number[] = []
    for await (const chunk of src.stream()) {
      received.push(...chunk)
    }
    expect(new Uint8Array(received)).toEqual(bytes)
    await grp.jensen.disconnect()
  })
})
