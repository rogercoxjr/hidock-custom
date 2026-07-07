import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Phase 1 device-sync — Task 10: "Connect gesture + silent reconnect".
//
// IMPORTANT ARCHITECTURE NOTE (see task-10-report.md for full detail):
// Device.tsx's Connect button does NOT call `window.electronAPI.jensen.connect()`.
// It calls `deviceService.connect()` (getHiDockDeviceService(), backed by the
// renderer-side `JensenDevice` singleton in `src/services/jensen.ts` — real
// WebUSB, not stubbed). This is a *different*, older, already-real connection
// stack than the one Task 9 built at `src/lib/electron-api/groups/device.ts`
// (window.electronAPI.jensen), which in classic Electron is backed by a
// SEPARATE, ALSO-real main-process node-usb JensenDevice
// (electron/main/services/jensen.ts, registered in electron/main/ipc/handlers.ts).
//
// Wiring Device.tsx's button to window.electronAPI.jensen.connect() would mean
// a single click can drive TWO independent real hardware stacks (renderer
// WebUSB + main-process node-usb) against the same physical device — exactly
// the "switching between USB APIs on the same device" hazard CLAUDE.md calls
// out as a repeat cause of real device lockups. It would also strand the rest
// of the app's device-state plumbing (battery polling, sync, download
// orchestration — all keyed off deviceService's own state), since none of
// that listens to window.electronAPI.jensen.
//
// This test therefore verifies the REAL, already-correct integration point
// (deviceService.connect()/isConnected(), which — via getJensenDevice() —
// already delegates to a real, non-stubbed WebUSB JensenDevice.connect()),
// mirroring the mocking pattern in Device.test.tsx.
// ---------------------------------------------------------------------------

const mockDeviceService = {
  isConnected: vi.fn(() => false),
  isP1Device: vi.fn(() => false),
  getAutoConnectConfig: vi.fn(() => ({ enabled: false, intervalMs: 5000, connectOnStartup: false })),
  setAutoConnectConfig: vi.fn(),
  getBatteryStatus: vi.fn().mockResolvedValue(null),
  onConnectionChange: vi.fn(() => () => {}),
  onDownloadProgress: vi.fn(() => () => {}),
  connect: vi.fn().mockResolvedValue(true),
  tryConnect: vi.fn().mockResolvedValue(false),
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

vi.mock('@/hooks/useDownloadOrchestrator', () => ({
  cancelDownloads: vi.fn(),
  processPendingDownloads: vi.fn(),
  retryFailedDownloads: vi.fn()
}))

vi.mock('@/hooks/useUnifiedRecordings', () => ({
  useUnifiedRecordings: vi.fn(() => ({ recordings: [], loading: false, error: null, refresh: vi.fn() }))
}))

vi.mock('@/components/DeviceFileList', () => ({
  DeviceFileList: () => null
}))

const mockSetDeviceSyncState = vi.fn()

vi.mock('@/store/useAppStore', () => {
  const useAppStore: any = vi.fn((selector: any) => {
    const state = {
      deviceSyncing: false,
      deviceState: {
        connected: false,
        model: null,
        serialNumber: null,
        firmwareVersion: null,
        storage: null,
        settings: null,
        recordingCount: 0
      },
      connectionStatus: { step: 'idle', message: '' },
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

vi.mock('@/store/domain/useConfigStore', () => ({
  useConfigStore: vi.fn((selector?: any) => {
    const state = { config: { transcription: { autoTranscribe: false } } }
    return typeof selector === 'function' ? selector(state) : state
  })
}))

vi.mock('@/components/ui/toaster', () => {
  const toast: any = vi.fn()
  toast.success = vi.fn()
  toast.error = vi.fn()
  toast.warning = vi.fn()
  toast.info = vi.fn()
  return { toast }
})

import Device from '../Device'

// Radix AlertDialog touches ResizeObserver — polyfill for jsdom (matches Device.test.tsx).
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() { /* no-op */ }
    unobserve() { /* no-op */ }
    disconnect() { /* no-op */ }
  } as any
}

describe('Device — Connect gesture + silent reconnect (Phase 1 Task 10)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeviceService.isConnected.mockReturnValue(false)
    mockDeviceService.getAutoConnectConfig.mockReturnValue({
      enabled: false,
      intervalMs: 5000,
      connectOnStartup: false
    })

    global.window.electronAPI = {
      downloadService: {
        getFilesToSync: vi.fn().mockResolvedValue([]),
        queueDownloads: vi.fn().mockResolvedValue([]),
        getState: vi.fn().mockResolvedValue({ queue: [] }),
        onStateUpdate: vi.fn(() => () => {}),
        retryFailed: vi.fn().mockResolvedValue({ count: 0 }),
        cancelPendingDownloads: vi.fn().mockResolvedValue(0)
      },
      syncedFiles: {
        getFilenames: vi.fn().mockResolvedValue([])
      },
      config: {
        get: vi.fn().mockResolvedValue({
          success: true,
          data: {
            device: { autoConnect: false, autoDownload: true },
            transcription: { autoTranscribe: false }
          }
        }),
        updateSection: vi.fn().mockResolvedValue({ success: true })
      }
    } as any
  })

  it('clicking "Connect Device" calls the real device connect path (deviceService.connect)', async () => {
    render(<Device />)

    const btn = await screen.findByRole('button', { name: /Connect Device/i })
    fireEvent.click(btn)

    await waitFor(() => expect(mockDeviceService.connect).toHaveBeenCalledTimes(1))
  })

  it('mounting the page does not crash even though no device is connected (silent-reconnect-safe)', async () => {
    // Reconnect-on-mount is handled app-wide by App.tsx's deviceService.initAutoConnect()
    // (which itself calls the real, already-non-stubbed jensen.tryConnect() and never
    // throws synchronously into the caller). Device.tsx must simply render cleanly
    // with no connected device and no crash — it does not duplicate the reconnect effect.
    expect(() => render(<Device />)).not.toThrow()
    expect(await screen.findByText(/No device connected/i)).toBeInTheDocument()
  })
})
