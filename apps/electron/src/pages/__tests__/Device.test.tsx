import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Device } from '../Device'

// ---------------------------------------------------------------------------
// Auto-pipeline P5 fix — Task 2: confirmation gate on large manual Sync.
// These tests exercise handleSyncAll's count/size threshold + ConfirmDialog
// flow. Renderer-only (jsdom); USB/transfer code is never touched here.
// ---------------------------------------------------------------------------

// --- hidock-device service mock -------------------------------------------
const mockDeviceService = {
  isConnected: vi.fn(() => true),
  isP1Device: vi.fn(() => false),
  getAutoConnectConfig: vi.fn(() => ({ enabled: false, intervalMs: 5000, connectOnStartup: false })),
  setAutoConnectConfig: vi.fn(),
  getBatteryStatus: vi.fn().mockResolvedValue(null),
  onConnectionChange: vi.fn(() => () => {}),
  onDownloadProgress: vi.fn(() => () => {}),
  connect: vi.fn().mockResolvedValue(true),
  disconnect: vi.fn().mockResolvedValue(undefined),
  resetDevice: vi.fn().mockResolvedValue(true),
  formatStorage: vi.fn().mockResolvedValue(true),
  clearActivityLog: vi.fn(),
  stopAutoConnect: vi.fn(),
  startRealtime: vi.fn().mockResolvedValue(true),
  pauseRealtime: vi.fn().mockResolvedValue(true),
  stopRealtime: vi.fn().mockResolvedValue(undefined),
  getRealtimeData: vi.fn().mockResolvedValue(null),
  setAutoRecord: vi.fn().mockResolvedValue(true),
  startBluetoothScan: vi.fn().mockResolvedValue(true)
}

vi.mock('@/services/hidock-device', () => ({
  getHiDockDeviceService: () => mockDeviceService,
  BatteryStatus: {}
}))

// --- useDownloadOrchestrator mock -----------------------------------------
vi.mock('@/hooks/useDownloadOrchestrator', () => ({
  cancelDownloads: vi.fn(),
  retryFailedDownloads: vi.fn()
}))

// --- useUnifiedRecordings mock --------------------------------------------
vi.mock('@/hooks/useUnifiedRecordings', () => ({
  useUnifiedRecordings: vi.fn()
}))

// --- DeviceFileList mock (not under test; pulls extra store hooks) ---------
vi.mock('@/components/DeviceFileList', () => ({
  DeviceFileList: () => null
}))

// --- app store mock --------------------------------------------------------
const mockSetDeviceSyncState = vi.fn()
let mockDeviceSyncing = false

vi.mock('@/store/useAppStore', () => {
  const useAppStore: any = vi.fn((selector: any) => {
    const state = {
      deviceSyncing: mockDeviceSyncing,
      deviceState: {
        connected: true,
        model: 'p1',
        serialNumber: 'SN-TEST',
        firmwareVersion: '1.0.0',
        storage: null,
        settings: null,
        recordingCount: 58
      },
      connectionStatus: { step: 'ready', message: 'Connected' },
      activityLog: [],
      setDeviceSyncState: mockSetDeviceSyncState,
      deviceSyncProgress: null,
      deviceSyncEta: null,
      clearActivityLog: vi.fn(),
      invalidateUnifiedRecordings: vi.fn()
    }
    return typeof selector === 'function' ? selector(state) : state
  })
  useAppStore.getState = () => ({
    clearActivityLog: vi.fn(),
    invalidateUnifiedRecordings: vi.fn(),
    // useOperations.syncDeviceFiles/syncOne now drive sync state + the download
    // queue through getState(); reuse mockSetDeviceSyncState so the existing
    // deviceSyncing assertions still capture calls from this path too.
    setDeviceSyncState: mockSetDeviceSyncState,
    clearDeviceSyncState: vi.fn(),
    addToDownloadQueue: vi.fn(),
    removeFromDownloadQueue: vi.fn()
  })
  return { useAppStore }
})

// --- config store mock -----------------------------------------------------
let mockAutoTranscribe = false
vi.mock('@/store/domain/useConfigStore', () => ({
  useConfigStore: vi.fn((selector?: any) => {
    const state = {
      config: {
        transcription: { autoTranscribe: mockAutoTranscribe }
      }
    }
    return typeof selector === 'function' ? selector(state) : state
  })
}))

// --- toaster mock ----------------------------------------------------------
vi.mock('@/components/ui/toaster', () => {
  const toast: any = vi.fn()
  toast.success = vi.fn()
  toast.error = vi.fn()
  toast.warning = vi.fn()
  toast.info = vi.fn()
  return { toast }
})

import { useUnifiedRecordings } from '@/hooks/useUnifiedRecordings'

// --- electronAPI mock ------------------------------------------------------
const mockGetFilesToSync = vi.fn()
const mockDeviceFileSource = vi.fn((filename: string, size: number) => ({
  filename, size, async *stream() { /* no chunks needed — syncFile is mocked */ }
}))
const mockSyncFile = vi.fn()
const mockGetState = vi.fn().mockResolvedValue({ queue: [] })
const mockOnStateUpdate = vi.fn(() => () => {})
const mockCancelPendingDownloads = vi.fn().mockResolvedValue(0)

global.window.electronAPI = {
  downloadService: {
    getFilesToSync: mockGetFilesToSync,
    deviceFileSource: mockDeviceFileSource,
    getState: mockGetState,
    onStateUpdate: mockOnStateUpdate,
    retryFailed: vi.fn().mockResolvedValue({ count: 0 }),
    cancelPendingDownloads: mockCancelPendingDownloads
  },
  deviceSync: {
    syncFile: mockSyncFile
  },
  syncedFiles: {
    getFilenames: vi.fn().mockResolvedValue([])
  },
  config: {
    get: vi.fn().mockResolvedValue({
      success: true,
      data: {
        device: { autoConnect: false, autoDownload: true },
        transcription: { autoTranscribe: mockAutoTranscribe }
      }
    }),
    updateSection: vi.fn().mockResolvedValue({ success: true })
  }
} as any

// Radix AlertDialog touches ResizeObserver — polyfill for jsdom.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() { /* no-op */ }
    unobserve() { /* no-op */ }
    disconnect() { /* no-op */ }
  } as any
}

// Build N device-only recordings (each `size` bytes) that read as not-synced.
function makeDeviceRecordings(count: number, size: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `dev-${i}`,
    filename: `rec-${i}.hda`,
    deviceFilename: `rec-${i}.hda`,
    size,
    duration: 60,
    dateRecorded: new Date('2026-06-10T12:00:00Z'),
    location: 'device-only' as const,
    syncStatus: 'not-synced' as const,
    transcriptionStatus: 'none' as const
  }))
}

// Build N "both locations" recordings (already downloaded AND still on device) — these are
// the "already synced" case for handleSyncAll, which now filters via isDeviceOnly() directly
// (no more getFilesToSync reconciliation call).
function makeBothLocationsRecordings(count: number, size: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `both-${i}`,
    filename: `both-${i}.hda`,
    deviceFilename: `both-${i}.hda`,
    localPath: `/recordings/both-${i}.hda`,
    size,
    duration: 60,
    dateRecorded: new Date('2026-06-10T12:00:00Z'),
    location: 'both' as const,
    syncStatus: 'synced' as const,
    transcriptionStatus: 'none' as const
  }))
}

// What getFilesToSync returns (IPC-serialized: dateCreated may be a string).
function filesToSyncResult(count: number, size: number) {
  return Array.from({ length: count }, (_, i) => ({
    filename: `rec-${i}.hda`,
    size,
    duration: 60,
    dateCreated: '2026-06-10T12:00:00.000Z',
    skipReason: undefined as string | undefined
  }))
}

const renderDevice = () => render(<Device />)

describe('Device — manual Sync confirmation gate (Defect 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeviceSyncing = false
    mockAutoTranscribe = false
    mockDeviceService.isConnected.mockReturnValue(true)
    mockSyncFile.mockResolvedValue({ recordingId: 'r', status: 'synced' })
    mockGetState.mockResolvedValue({ queue: [] })
    mockOnStateUpdate.mockReturnValue(() => {})
    mockCancelPendingDownloads.mockResolvedValue(0)
  })

  const clickSync = async () => {
    const btn = await screen.findByRole('button', { name: /Sync \d+ Recording/i })
    fireEvent.click(btn)
    return btn
  }

  it('small sync (3 files) proceeds silently — queues without a dialog', async () => {
    const size = 1024 // tiny
    vi.mocked(useUnifiedRecordings).mockReturnValue({
      recordings: makeDeviceRecordings(3, size),
      loading: false,
      error: null,
      refresh: vi.fn()
    } as any)
    mockGetFilesToSync.mockResolvedValue(filesToSyncResult(3, size))

    renderDevice()
    await clickSync()

    await waitFor(() => {
      expect(mockSyncFile).toHaveBeenCalledTimes(3)
    })
    expect(mockDeviceFileSource).toHaveBeenCalledWith('rec-0.hda', size)
    expect(mockDeviceFileSource).toHaveBeenCalledWith('rec-1.hda', size)
    expect(mockDeviceFileSource).toHaveBeenCalledWith('rec-2.hda', size)
    // No confirmation dialog rendered.
    expect(screen.queryByText(/Download recordings\?/i)).not.toBeInTheDocument()
  })

  it('sets deviceSyncing true while syncing and false once the hosted sync settles', async () => {
    const size = 1024
    vi.mocked(useUnifiedRecordings).mockReturnValue({
      recordings: makeDeviceRecordings(3, size),
      loading: false,
      error: null,
      refresh: vi.fn()
    } as any)
    mockGetFilesToSync.mockResolvedValue(filesToSyncResult(3, size))

    renderDevice()
    await clickSync()

    await waitFor(() => {
      expect(mockSyncFile).toHaveBeenCalledTimes(3)
    })
    // performSync now awaits syncDeviceFiles directly (hosted device-sync client) rather
    // than queueing to a download orchestrator, so it must own the full deviceSyncing
    // lifecycle itself: true before syncing, false once settled (finally block).
    expect(mockSetDeviceSyncState).toHaveBeenCalledWith({ deviceSyncing: true })
    await waitFor(() => {
      expect(mockSetDeviceSyncState).toHaveBeenCalledWith({ deviceSyncing: false })
    })
  })

  it('shows an error toast when every file fails to sync (not a false "nothing to sync")', async () => {
    const size = 1024
    vi.mocked(useUnifiedRecordings).mockReturnValue({
      recordings: makeDeviceRecordings(3, size),
      loading: false,
      error: null,
      refresh: vi.fn()
    } as any)
    mockGetFilesToSync.mockResolvedValue(filesToSyncResult(3, size))
    // Every file in the non-empty list fails (e.g. server unreachable) → syncDeviceFiles
    // resolves 0. That must surface as a total-failure error, not a benign no-op.
    mockSyncFile.mockRejectedValue(new Error('Server unreachable'))

    renderDevice()
    await clickSync()

    await waitFor(() => {
      expect(mockSyncFile).toHaveBeenCalledTimes(3)
    })

    const { toast } = await import('@/components/ui/toaster')
    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Sync failed', variant: 'error' })
      )
    })
    // Must NOT report this as a no-op success.
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Nothing to sync' }))
  })

  it('does NOT sync any files when there is nothing to sync', async () => {
    // No device-only recordings in the unified-recordings list (e.g. the device's raw
    // recordingCount — used only for the button's optimistic label heuristic — hasn't been
    // reconciled into the list yet). handleSyncAll computes toSync via
    // `recordings.filter(isDeviceOnly)` directly (no more getFilesToSync reconciliation
    // call), so an empty/non-device-only recordings list means nothing to sync regardless
    // of what the button label says.
    vi.mocked(useUnifiedRecordings).mockReturnValue({
      recordings: [],
      loading: false,
      error: null,
      refresh: vi.fn()
    } as any)

    renderDevice()
    await clickSync()

    const { toast } = await import('@/components/ui/toaster')
    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'All synced' }))
    })
    expect(mockSyncFile).not.toHaveBeenCalled()
    expect(mockGetFilesToSync).not.toHaveBeenCalled()
  })

  it('only syncs device-only recordings, skipping ones already downloaded (both locations)', async () => {
    const size = 1024
    // Mix of 3 device-only (need sync) + 2 both-locations (already downloaded) recordings.
    // handleSyncAll must sync only the 3 device-only ones and must not call getFilesToSync.
    vi.mocked(useUnifiedRecordings).mockReturnValue({
      recordings: [...makeDeviceRecordings(3, size), ...makeBothLocationsRecordings(2, size)],
      loading: false,
      error: null,
      refresh: vi.fn()
    } as any)

    renderDevice()
    await clickSync()

    await waitFor(() => {
      expect(mockSyncFile).toHaveBeenCalledTimes(3)
    })
    expect(mockDeviceFileSource).toHaveBeenCalledWith('rec-0.hda', size)
    expect(mockDeviceFileSource).toHaveBeenCalledWith('rec-1.hda', size)
    expect(mockDeviceFileSource).toHaveBeenCalledWith('rec-2.hda', size)
    expect(mockGetFilesToSync).not.toHaveBeenCalled()
  })

  it('large sync (58 files) confirms first — no queue until confirm clicked', async () => {
    const size = 50 * 1024 * 1024 // 50 MB each → ~2.8 GB total, > size threshold too
    vi.mocked(useUnifiedRecordings).mockReturnValue({
      recordings: makeDeviceRecordings(58, size),
      loading: false,
      error: null,
      refresh: vi.fn()
    } as any)
    mockGetFilesToSync.mockResolvedValue(filesToSyncResult(58, size))

    renderDevice()
    await clickSync()

    // Dialog shown; sync NOT called yet.
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/58 recordings/i)).toBeInTheDocument()
    // Estimated size present (GB string for ~2.8 GB).
    expect(within(dialog).getByText(/GB/i)).toBeInTheDocument()
    expect(mockSyncFile).not.toHaveBeenCalled()

    // Confirm → now it syncs all 58.
    const confirmBtn = within(dialog).getByRole('button', { name: /^Download$/i })
    fireEvent.click(confirmBtn)

    await waitFor(() => {
      expect(mockSyncFile).toHaveBeenCalledTimes(58)
    })
  })

  it('cancel queues nothing and resets syncing state', async () => {
    const size = 50 * 1024 * 1024
    vi.mocked(useUnifiedRecordings).mockReturnValue({
      recordings: makeDeviceRecordings(58, size),
      loading: false,
      error: null,
      refresh: vi.fn()
    } as any)
    mockGetFilesToSync.mockResolvedValue(filesToSyncResult(58, size))

    renderDevice()
    await clickSync()

    const dialog = await screen.findByRole('alertdialog')
    const cancelBtn = within(dialog).getByRole('button', { name: /^Cancel$/i })
    fireEvent.click(cancelBtn)

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    expect(mockSyncFile).not.toHaveBeenCalled()
    // performSync was never entered, so deviceSyncing was never set true.
    expect(mockSetDeviceSyncState).not.toHaveBeenCalledWith({ deviceSyncing: true })
  })

  it('size threshold trips with few files but large bytes (> 200 MB)', async () => {
    const size = 80 * 1024 * 1024 // 4 files * 80 MB = 320 MB > 200 MB, count (4) <= 5
    vi.mocked(useUnifiedRecordings).mockReturnValue({
      recordings: makeDeviceRecordings(4, size),
      loading: false,
      error: null,
      refresh: vi.fn()
    } as any)
    mockGetFilesToSync.mockResolvedValue(filesToSyncResult(4, size))

    renderDevice()
    await clickSync()

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/4 recordings/i)).toBeInTheDocument()
    expect(mockSyncFile).not.toHaveBeenCalled()
  })

  it('all-synced shows "All synced" toast, no dialog, no queue', async () => {
    // No device-only recordings → toSync empty (see "does NOT sync any files..." above for
    // why the recordings list, not getFilesToSync, drives this now).
    vi.mocked(useUnifiedRecordings).mockReturnValue({
      recordings: [],
      loading: false,
      error: null,
      refresh: vi.fn()
    } as any)

    renderDevice()
    await clickSync()

    const { toast } = await import('@/components/ui/toaster')
    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'All synced' })
      )
    })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(mockSyncFile).not.toHaveBeenCalled()
    expect(mockGetFilesToSync).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Orphaned-pending fix — Task 3: "Clear queue" affordance for queued-but-not-started
// (pending) downloads. Renderer-only; USB/transfer code is never touched here.
// ---------------------------------------------------------------------------

describe('Device — clear queued-but-not-started downloads (Task 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeviceSyncing = false
    mockAutoTranscribe = false
    mockDeviceService.isConnected.mockReturnValue(true)
    mockGetState.mockResolvedValue({ queue: [] })
    mockOnStateUpdate.mockReturnValue(() => {})
    mockCancelPendingDownloads.mockResolvedValue(2)
    vi.mocked(useUnifiedRecordings).mockReturnValue({
      recordings: makeDeviceRecordings(3, 1024),
      loading: false,
      error: null,
      refresh: vi.fn()
    } as any)
  })

  it('shows a "Clear queue" control when there are pending items and no active sync', async () => {
    mockGetState.mockResolvedValue({
      queue: [
        { id: 'p1.hda', filename: 'p1.hda', fileSize: 1024, progress: 0, status: 'pending' },
        { id: 'p2.hda', filename: 'p2.hda', fileSize: 2048, progress: 0, status: 'pending' }
      ]
    })
    mockGetFilesToSync.mockResolvedValue(filesToSyncResult(3, 1024))

    renderDevice()

    const clearBtn = await screen.findByRole('button', { name: /Clear queue/i })
    expect(clearBtn).toBeInTheDocument()
  })

  it('clicking "Clear queue" calls cancelPendingDownloads', async () => {
    mockGetState.mockResolvedValue({
      queue: [
        { id: 'p1.hda', filename: 'p1.hda', fileSize: 1024, progress: 0, status: 'pending' },
        { id: 'p2.hda', filename: 'p2.hda', fileSize: 2048, progress: 0, status: 'pending' }
      ]
    })
    mockGetFilesToSync.mockResolvedValue(filesToSyncResult(3, 1024))

    renderDevice()

    const clearBtn = await screen.findByRole('button', { name: /Clear queue/i })
    fireEvent.click(clearBtn)

    await waitFor(() => {
      expect(mockCancelPendingDownloads).toHaveBeenCalledTimes(1)
    })
  })

  it('does NOT show "Clear queue" when there are no pending items', async () => {
    mockGetState.mockResolvedValue({ queue: [] })
    mockGetFilesToSync.mockResolvedValue(filesToSyncResult(3, 1024))

    renderDevice()

    // Let the mount-load settle.
    await screen.findByRole('button', { name: /Sync \d+ Recording/i })
    expect(screen.queryByRole('button', { name: /Clear queue/i })).not.toBeInTheDocument()
  })
})
