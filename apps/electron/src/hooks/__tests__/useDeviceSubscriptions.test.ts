import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

// ---- Hoisted mock state (vi.mock factories are hoisted; shared refs must be too) ----

const h = vi.hoisted(() => {
  // Capture the onStatusChange callback so tests can drive the status-ready path.
  const ref: { capturedStatusChange: ((status: { step: string; message?: string }) => void) | null } = {
    capturedStatusChange: null
  }
  const deviceServiceMock = {
    getState: vi.fn(() => ({
      connected: true,
      model: 'p1' as const,
      serialNumber: 'SN1' as string | null,
      firmwareVersion: null,
      storage: null,
      settings: null,
      recordingCount: 0
    })),
    getConnectionStatus: vi.fn(() => ({ step: 'idle', message: 'Not connected' })),
    getCachedRecordings: vi.fn(
      () => [] as Array<{ filename: string; size: number; duration: number; dateCreated: Date }>
    ),
    listRecordings: vi.fn(
      async () => [] as Array<{ filename: string; size: number; duration: number; dateCreated: Date }>
    ),
    isConnected: vi.fn(() => true),
    onStateChange: vi.fn(() => () => {}),
    onStatusChange: vi.fn((cb: (status: { step: string; message?: string }) => void) => {
      ref.capturedStatusChange = cb
      return () => {}
    }),
    onActivity: vi.fn(() => () => {}),
    log: vi.fn()
  }
  const autoSyncGuardMock = {
    checkAutoSyncAllowed: vi.fn(() => ({ allowed: true, reason: 'All preconditions met' })),
    waitForConfig: vi.fn(async () => true),
    // forced false so ONLY the status-ready path drives runAutoSyncReconcile in these tests
    waitForDeviceReady: vi.fn(async () => false)
  }
  const storeActions = {
    setDeviceState: vi.fn(),
    setConnectionStatus: vi.fn(),
    addActivityLogEntry: vi.fn(),
    setDeviceSyncState: vi.fn()
  }
  return { ref, deviceServiceMock, autoSyncGuardMock, storeActions }
})

vi.mock('@/services/hidock-device', () => ({
  getHiDockDeviceService: vi.fn(() => h.deviceServiceMock)
}))

vi.mock('@/utils/autoSyncGuard', () => h.autoSyncGuardMock)

// QA monitor: keep logs on so the QA skip line is exercised; assert via console spy.
vi.mock('@/services/qa-monitor', () => ({
  shouldLogQa: vi.fn(() => true)
}))

vi.mock('@/store/useAppStore', () => ({
  useAppStore: vi.fn((selector: (s: typeof h.storeActions) => unknown) => selector(h.storeActions))
}))

import { useDeviceSubscriptions } from '../useDeviceSubscriptions'

const { deviceServiceMock, autoSyncGuardMock, storeActions, ref } = h

// ---- Electron API mock ----

function createDownloadServiceMock() {
  return {
    ensureBaseline: vi.fn(async () => ({ created: false })),
    getFilesToSync: vi.fn(async (files: Array<{ filename: string }>) =>
      files.map((f) => ({ ...f, skipReason: undefined as string | undefined }))
    ),
    startSession: vi.fn(async (_files: Array<{ filename: string; size: number; dateCreated?: string }>) => ({
      sessionId: 's1'
    })),
    cancelActive: vi.fn(async () => 0)
  }
}

let downloadServiceMock = createDownloadServiceMock()

function setElectronAPI() {
  global.window.electronAPI = {
    downloadService: downloadServiceMock,
    onActivityLogEntry: vi.fn(() => () => {})
  } as unknown as typeof window.electronAPI
}

const REC_A = { filename: 'a.hda', size: 100, duration: 10, dateCreated: new Date('2025-01-01T00:00:00Z') }
const REC_B = { filename: 'b.hda', size: 200, duration: 20, dateCreated: new Date('2025-01-02T00:00:00Z') }

/** Drive the status-ready trigger path: invoke captured callback then flush the 2s debounce. */
async function driveStatusReady() {
  expect(ref.capturedStatusChange).not.toBeNull()
  ref.capturedStatusChange!({ step: 'ready', message: 'Ready' })
  // spec-007: the reconcile is scheduled behind a 2s debounce timer.
  await vi.advanceTimersByTimeAsync(2000)
  // Let the awaited ensure-baseline / getFilesToSync / startSession promises settle.
  await vi.runAllTimersAsync()
}

describe('useDeviceSubscriptions — auto-sync baseline gate (status-ready path)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ref.capturedStatusChange = null
    vi.useFakeTimers()
    downloadServiceMock = createDownloadServiceMock()
    setElectronAPI()
    // Default mock state restored after clearAllMocks().
    deviceServiceMock.getState.mockReturnValue({
      connected: true,
      model: 'p1',
      serialNumber: 'SN1',
      firmwareVersion: null,
      storage: null,
      settings: null,
      recordingCount: 2
    })
    deviceServiceMock.getConnectionStatus.mockReturnValue({ step: 'idle', message: 'Not connected' })
    deviceServiceMock.isConnected.mockReturnValue(true)
    deviceServiceMock.onStatusChange.mockImplementation(
      (cb: (status: { step: string; message?: string }) => void) => {
        ref.capturedStatusChange = cb
        return () => {}
      }
    )
    deviceServiceMock.onStateChange.mockReturnValue(() => {})
    deviceServiceMock.onActivity.mockReturnValue(() => {})
    deviceServiceMock.getCachedRecordings.mockReturnValue([REC_A, REC_B])
    autoSyncGuardMock.checkAutoSyncAllowed.mockReturnValue({ allowed: true, reason: 'ok' })
    autoSyncGuardMock.waitForConfig.mockResolvedValue(true)
    autoSyncGuardMock.waitForDeviceReady.mockResolvedValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('Fresh device: ensureBaseline created → snapshots and queues nothing (AC2 first half)', async () => {
    downloadServiceMock.ensureBaseline.mockResolvedValue({ created: true })

    renderHook(() => useDeviceSubscriptions())
    await driveStatusReady()

    expect(downloadServiceMock.ensureBaseline).toHaveBeenCalledWith('SN1', ['a.hda', 'b.hda'])
    expect(downloadServiceMock.getFilesToSync).not.toHaveBeenCalled()
    expect(downloadServiceMock.startSession).not.toHaveBeenCalled()
    // A baseline log entry is emitted via deviceService.log
    expect(deviceServiceMock.log).toHaveBeenCalledWith(
      'info',
      'Baseline established',
      expect.stringContaining('baseline')
    )
  })

  it('Baselined device: getFilesToSync called with auto opts; startSession with non-skipped files (AC2 second half)', async () => {
    downloadServiceMock.ensureBaseline.mockResolvedValue({ created: false })
    // a.hda is in the baseline (skipped); b.hda is new (queued)
    downloadServiceMock.getFilesToSync.mockResolvedValue([
      { ...REC_A, skipReason: 'baseline' },
      { ...REC_B, skipReason: undefined }
    ])

    renderHook(() => useDeviceSubscriptions())
    await driveStatusReady()

    expect(downloadServiceMock.getFilesToSync).toHaveBeenCalledWith(
      [
        { filename: 'a.hda', size: 100, duration: 10, dateCreated: REC_A.dateCreated },
        { filename: 'b.hda', size: 200, duration: 20, dateCreated: REC_B.dateCreated }
      ],
      { auto: true, deviceSerial: 'SN1' }
    )
    expect(downloadServiceMock.startSession).toHaveBeenCalledTimes(1)
    const queued = downloadServiceMock.startSession.mock.calls[0][0]
    expect(queued.map((q) => q.filename)).toEqual(['b.hda'])
    // deviceSyncState is set with the queue total
    expect(storeActions.setDeviceSyncState).toHaveBeenCalledWith(
      expect.objectContaining({ deviceSyncing: true, deviceFileDownloading: 'b.hda' })
    )
  })

  it('Null serial: neither ensureBaseline nor getFilesToSync called; QA skip line; no throw', async () => {
    deviceServiceMock.getState.mockReturnValue({
      connected: true,
      model: 'p1',
      serialNumber: null,
      firmwareVersion: null,
      storage: null,
      settings: null,
      recordingCount: 2
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    renderHook(() => useDeviceSubscriptions())
    await expect(driveStatusReady()).resolves.toBeUndefined()

    // Asserted directly — not relying on the path's catch to save us.
    expect(downloadServiceMock.ensureBaseline).not.toHaveBeenCalled()
    expect(downloadServiceMock.getFilesToSync).not.toHaveBeenCalled()
    expect(downloadServiceMock.startSession).not.toHaveBeenCalled()
    // A QA skip line + a device-service skip log
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Auto-sync skipped: device reported no serial number')
    )
    expect(deviceServiceMock.log).toHaveBeenCalledWith(
      'info',
      'Auto-sync skipped',
      expect.stringContaining('serial')
    )
    logSpy.mockRestore()
  })

  it('All-skipped: getFilesToSync returns all with skipReasons → startSession NOT called, "All files synced" log', async () => {
    downloadServiceMock.ensureBaseline.mockResolvedValue({ created: false })
    downloadServiceMock.getFilesToSync.mockResolvedValue([
      { ...REC_A, skipReason: 'baseline' },
      { ...REC_B, skipReason: 'synced' }
    ])

    renderHook(() => useDeviceSubscriptions())
    await driveStatusReady()

    expect(downloadServiceMock.getFilesToSync).toHaveBeenCalled()
    expect(downloadServiceMock.startSession).not.toHaveBeenCalled()
    expect(deviceServiceMock.log).toHaveBeenCalledWith(
      'success',
      'All files synced',
      'No new recordings to download'
    )
  })
})

describe('useDeviceSubscriptions — auto-sync guard race (Defect 3: both trigger paths)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ref.capturedStatusChange = null
    vi.useFakeTimers()
    downloadServiceMock = createDownloadServiceMock()
    setElectronAPI()
    deviceServiceMock.getState.mockReturnValue({
      connected: true,
      model: 'p1',
      serialNumber: 'SN1',
      firmwareVersion: null,
      storage: null,
      settings: null,
      recordingCount: 2
    })
    deviceServiceMock.getConnectionStatus.mockReturnValue({ step: 'idle', message: 'Not connected' })
    deviceServiceMock.isConnected.mockReturnValue(true)
    deviceServiceMock.onStatusChange.mockImplementation(
      (cb: (status: { step: string; message?: string }) => void) => {
        ref.capturedStatusChange = cb
        return () => {}
      }
    )
    deviceServiceMock.onStateChange.mockReturnValue(() => {})
    deviceServiceMock.onActivity.mockReturnValue(() => {})
    deviceServiceMock.getCachedRecordings.mockReturnValue([REC_A, REC_B])
    autoSyncGuardMock.checkAutoSyncAllowed.mockReturnValue({ allowed: true, reason: 'ok' })
    autoSyncGuardMock.waitForConfig.mockResolvedValue(true)
    // BOTH paths armed: pre-connected (Path B) AND status-ready (Path A).
    autoSyncGuardMock.waitForDeviceReady.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('Both paths fire on one connect → reconcile runs at most once (startSession called ≤ 1×)', async () => {
    // created:false so the observable effect is startSession (not a baseline short-circuit).
    downloadServiceMock.ensureBaseline.mockResolvedValue({ created: false })
    // b.hda is new → would be queued by EACH path that runs reconcile.
    downloadServiceMock.getFilesToSync.mockResolvedValue([
      { ...REC_A, skipReason: 'baseline' },
      { ...REC_B, skipReason: undefined }
    ])

    renderHook(() => useDeviceSubscriptions())

    // Path A: status becomes 'ready' → schedules its 2s debounce.
    expect(ref.capturedStatusChange).not.toBeNull()
    ref.capturedStatusChange!({ step: 'ready', message: 'Ready' })

    // Path B (checkInitialAutoSync) runs concurrently: its waitForConfig/waitForDeviceReady
    // awaits resolve here, then it checks the guard and (if unlocked) runs reconcile.
    // Path A's debounce then fires. Drain everything.
    await vi.runAllTimersAsync()
    await vi.runAllTimersAsync()

    // The two paths must NOT both run the reconcile: startSession at most once.
    expect(downloadServiceMock.startSession.mock.calls.length).toBeLessThanOrEqual(1)
  })
})
