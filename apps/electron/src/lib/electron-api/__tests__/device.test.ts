/**
 * device.test.ts — Shape-assertion tests for the device SDK group (Task 9 / PHASE-1 un-stub).
 *
 * `makeDeviceGroup()` now delegates most jensen.* methods to a real `JensenDevice` instance
 * (see ../groups/device.ts and ../groups/__tests__/device-live.test.ts for mock-backed coverage
 * of the delegated methods). This file asserts the methods that have NO `JensenDevice`
 * counterpart and therefore remain Phase-1 stubs:
 *   - jensen.cancelDownload (no standalone cancel-in-flight primitive on JensenDevice — the
 *     real downloadFile() cancellation is expressed via an AbortSignal parameter instead)
 *   - all 6 jensen.on* event subscriptions (JensenDevice has no multi-subscriber event bus —
 *     just single-slot onconnect/ondisconnect callback properties and per-call
 *     onChunk/onProgress callbacks, not subscribable events; wiring a real pub-sub layer is
 *     connect/reconnect-gesture work for a later task)
 *   - most downloadService.* methods (queue/session orchestration has no renderer
 *     implementation yet; onStateUpdate is NOT in this group — it lives in events.ts)
 *
 * Six downloadService.* methods with real hosted-mode consumers (getState, ensureBaseline,
 * cancelActive, cancelAll, retryFailed, getFilesToSync) resolve to benign hosted defaults
 * instead of rejecting — asserted separately below.
 *
 * downloadService.deviceFileSource() (the one real addition to that namespace) is covered by
 * device-live.test.ts, not here.
 */

import { describe, it, expect } from 'vitest'
import { makeDeviceGroup } from '../groups/device'

const PHASE1_ERROR = 'device path is Phase 1'

describe('makeDeviceGroup — jensen stubs (no JensenDevice counterpart)', () => {
  const { jensen } = makeDeviceGroup()

  it('cancelDownload rejects with phase1 error', async () => {
    await expect(jensen.cancelDownload()).rejects.toThrow(PHASE1_ERROR)
  })

  // -------------------------------------------------------------------------
  // on* event stubs — must return a callable no-op unsubscribe
  // -------------------------------------------------------------------------

  it('onStateChanged returns a no-op unsubscribe function', () => {
    const unsub = jensen.onStateChanged(() => {})
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
  })

  it('onConnect returns a no-op unsubscribe function', () => {
    const unsub = jensen.onConnect(() => {})
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
  })

  it('onDisconnect returns a no-op unsubscribe function', () => {
    const unsub = jensen.onDisconnect(() => {})
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
  })

  it('onDownloadProgress returns a no-op unsubscribe function', () => {
    const unsub = jensen.onDownloadProgress(() => {})
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
  })

  it('onDownloadChunk returns a no-op unsubscribe function', () => {
    const unsub = jensen.onDownloadChunk(() => {})
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
  })

  it('onScanProgress returns a no-op unsubscribe function', () => {
    const unsub = jensen.onScanProgress(() => {})
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
  })
})

describe('makeDeviceGroup — downloadService stubs (excluding onStateUpdate)', () => {
  const { downloadService } = makeDeviceGroup()

  it('isFileSynced rejects with phase1 error', async () => {
    await expect(downloadService.isFileSynced('test.wav')).rejects.toThrow(PHASE1_ERROR)
  })

  it('queueDownloads rejects with phase1 error', async () => {
    await expect(downloadService.queueDownloads([{ filename: 'test.wav', size: 1024 }])).rejects.toThrow(PHASE1_ERROR)
  })

  it('startSession rejects with phase1 error', async () => {
    await expect(downloadService.startSession([{ filename: 'test.wav', size: 1024 }])).rejects.toThrow(PHASE1_ERROR)
  })

  it('processDownload rejects with phase1 error', async () => {
    await expect(downloadService.processDownload('test.wav', [])).rejects.toThrow(PHASE1_ERROR)
  })

  it('updateProgress rejects with phase1 error', async () => {
    await expect(downloadService.updateProgress('test.wav', 512)).rejects.toThrow(PHASE1_ERROR)
  })

  it('markFailed rejects with phase1 error', async () => {
    await expect(downloadService.markFailed('test.wav', 'timeout')).rejects.toThrow(PHASE1_ERROR)
  })

  it('clearCompleted rejects with phase1 error', async () => {
    await expect(downloadService.clearCompleted()).rejects.toThrow(PHASE1_ERROR)
  })

  it('cancel rejects with phase1 error', async () => {
    await expect(downloadService.cancel('test.wav')).rejects.toThrow(PHASE1_ERROR)
  })

  it('getStats rejects with phase1 error', async () => {
    await expect(downloadService.getStats()).rejects.toThrow(PHASE1_ERROR)
  })

  it('checkStalled rejects with phase1 error', async () => {
    await expect(downloadService.checkStalled()).rejects.toThrow(PHASE1_ERROR)
  })

  it('cancelPendingDownloads rejects with phase1 error', async () => {
    await expect(downloadService.cancelPendingDownloads()).rejects.toThrow(PHASE1_ERROR)
  })

  it('notifyCompletion rejects with phase1 error', async () => {
    await expect(
      downloadService.notifyCompletion({ completed: 3, failed: 0, aborted: false }),
    ).rejects.toThrow(PHASE1_ERROR)
  })

  // onStateUpdate is NOT in this group — assert it does not exist here
  it('onStateUpdate is NOT on the downloadService stubs object (it belongs to events.ts)', () => {
    expect((downloadService as any).onStateUpdate).toBeUndefined()
  })
})

describe('makeDeviceGroup — downloadService benign hosted defaults (real consumers, no longer reject)', () => {
  const { downloadService } = makeDeviceGroup()

  it('getState resolves to an idle, empty DownloadState', async () => {
    await expect(downloadService.getState()).resolves.toEqual({
      queue: [],
      session: null,
      isProcessing: false,
      isPaused: false,
    })
  })

  it('getFilesToSync resolves to an empty array', async () => {
    await expect(
      downloadService.getFilesToSync([{ filename: 'test.wav', size: 1024, duration: 60, dateCreated: new Date() }]),
    ).resolves.toEqual([])
  })

  it('ensureBaseline resolves to { created: false }', async () => {
    await expect(downloadService.ensureBaseline('SN123', ['test.wav'])).resolves.toEqual({ created: false })
  })

  it('cancelActive resolves to 0 (nothing to cancel)', async () => {
    await expect(downloadService.cancelActive('Device disconnected')).resolves.toBe(0)
  })

  it('cancelAll resolves (no-op)', async () => {
    await expect(downloadService.cancelAll()).resolves.toBeUndefined()
  })

  it('retryFailed resolves to { count: 0 } (no failed-download queue in hosted mode)', async () => {
    await expect(downloadService.retryFailed()).resolves.toEqual({ count: 0 })
  })
})
