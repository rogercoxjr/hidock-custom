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
  cancelDownloads: vi.fn()
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
    invalidateUnifiedRecordings: vi.fn()
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
const mockQueueDownloads = vi.fn()

global.window.electronAPI = {
  downloadService: {
    getFilesToSync: mockGetFilesToSync,
    queueDownloads: mockQueueDownloads,
    getState: vi.fn().mockResolvedValue({ queue: [] }),
    onStateUpdate: vi.fn(() => () => {}),
    retryFailed: vi.fn().mockResolvedValue({ count: 0 })
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
    mockQueueDownloads.mockResolvedValue(['id-1'])
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
      expect(mockQueueDownloads).toHaveBeenCalledTimes(1)
    })
    expect(mockQueueDownloads).toHaveBeenCalledWith([
      expect.objectContaining({ filename: 'rec-0.hda' }),
      expect.objectContaining({ filename: 'rec-1.hda' }),
      expect.objectContaining({ filename: 'rec-2.hda' })
    ])
    // No confirmation dialog rendered.
    expect(screen.queryByText(/Download recordings\?/i)).not.toBeInTheDocument()
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

    // Dialog shown; queue NOT called yet.
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/58 recordings/i)).toBeInTheDocument()
    // Estimated size present (GB string for ~2.8 GB).
    expect(within(dialog).getByText(/GB/i)).toBeInTheDocument()
    expect(mockQueueDownloads).not.toHaveBeenCalled()

    // Confirm → now it queues all 58.
    const confirmBtn = within(dialog).getByRole('button', { name: /^Download$/i })
    fireEvent.click(confirmBtn)

    await waitFor(() => {
      expect(mockQueueDownloads).toHaveBeenCalledTimes(1)
    })
    expect(mockQueueDownloads.mock.calls[0][0]).toHaveLength(58)
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
    expect(mockQueueDownloads).not.toHaveBeenCalled()
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
    expect(mockQueueDownloads).not.toHaveBeenCalled()
  })

  it('all-synced shows "All synced" toast, no dialog, no queue', async () => {
    const size = 50 * 1024 * 1024
    vi.mocked(useUnifiedRecordings).mockReturnValue({
      recordings: makeDeviceRecordings(58, size),
      loading: false,
      error: null,
      refresh: vi.fn()
    } as any)
    // Every file skipped → toSync empty.
    mockGetFilesToSync.mockResolvedValue(
      filesToSyncResult(58, size).map(f => ({ ...f, skipReason: 'already-synced' }))
    )

    renderDevice()
    await clickSync()

    const { toast } = await import('@/components/ui/toaster')
    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'All synced' })
      )
    })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(mockQueueDownloads).not.toHaveBeenCalled()
  })
})
