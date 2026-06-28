/**
 * device.ts — PHASE-1 stub group for jensen.* and downloadService.* (minus onStateUpdate).
 *
 * The browser WebUSB device path (0c §4) is Phase 1 and has no REST endpoint.
 * Per CONTRACTS.md §PHASE-1 section:
 *   - Methods reject / return safe defaults with a 'device path is Phase 1' marker.
 *   - on* events return a no-op () => void unsubscribe so subscribing components do not crash.
 *
 * NOTE: downloadService.onStateUpdate is handled by the events group (events.ts) — this
 * file provides the remaining 18 downloadService methods only.
 *
 * Compose in index.ts AFTER the events group seeds downloadService.onStateUpdate:
 *   Object.assign(api.jensen, makeDeviceGroup().jensen)
 *   Object.assign(api.downloadService, makeDeviceGroup().downloadService)
 * Or more conveniently:
 *   const deviceGroup = makeDeviceGroup()
 *   Object.assign(api, { jensen: deviceGroup.jensen })
 *   Object.assign(api.downloadService, deviceGroup.downloadService)
 */

// No external deps needed — all stubs.

const PHASE1_ERROR = 'device path is Phase 1'
const noop = (): void => {}

/** Returns a no-op unsubscribe function. */
function noopUnsub(): () => void {
  return noop
}

/** Returns a promise that always rejects with the Phase 1 marker. */
function phase1Reject<T = never>(): Promise<T> {
  return Promise.reject(new Error(PHASE1_ERROR))
}

export function makeDeviceGroup() {
  return {
    // -----------------------------------------------------------------------
    // jensen.* — 28 PHASE-1 method stubs + 6 on* event stubs
    // -----------------------------------------------------------------------
    jensen: {
      // Core
      connect: (): Promise<boolean> => phase1Reject(),
      tryConnect: (): Promise<boolean> => phase1Reject(),
      disconnect: (): Promise<void> => phase1Reject(),
      reset: (): Promise<boolean> => phase1Reject(),
      isConnected: (): Promise<boolean> => phase1Reject(),
      getModel: (): Promise<string | null> => phase1Reject(),
      isP1Device: (): Promise<boolean> => phase1Reject(),

      // Device info & settings
      getDeviceInfo: (): Promise<any> => phase1Reject(),
      getCardInfo: (): Promise<any> => phase1Reject(),
      getFileCount: (): Promise<{ count: number } | null> => phase1Reject(),
      getSettings: (): Promise<any> => phase1Reject(),
      setTime: (): Promise<any> => phase1Reject(),
      setAutoRecord: (_enabled: boolean): Promise<any> => phase1Reject(),

      // File operations
      listFiles: (): Promise<any[] | null> => phase1Reject(),
      downloadFile: (_filename: string, _fileSize: number): Promise<boolean | null> => phase1Reject(),
      cancelDownload: (): Promise<void> => phase1Reject(),
      deleteFile: (_filename: string): Promise<any> => phase1Reject(),
      formatCard: (): Promise<any> => phase1Reject(),

      // Realtime
      getRealtimeSettings: (): Promise<any> => phase1Reject(),
      startRealtime: (): Promise<any> => phase1Reject(),
      pauseRealtime: (): Promise<any> => phase1Reject(),
      stopRealtime: (): Promise<any> => phase1Reject(),
      getRealtimeData: (_offset: number): Promise<any> => phase1Reject(),

      // Battery & Bluetooth
      getBatteryStatus: (): Promise<any> => phase1Reject(),
      startBluetoothScan: (_duration?: number): Promise<any> => phase1Reject(),
      stopBluetoothScan: (): Promise<any> => phase1Reject(),
      getBluetoothStatus: (): Promise<any> => phase1Reject(),

      // Push event subscriptions (6 on* events)
      onStateChanged: (_callback: (state: {
        connected: boolean
        model: string | null
        serialNumber: string | null
        versionCode: string | null
        versionNumber: number | null
      }) => void): () => void => noopUnsub(),

      onConnect: (_callback: () => void): () => void => noopUnsub(),
      onDisconnect: (_callback: () => void): () => void => noopUnsub(),

      onDownloadProgress: (_callback: (data: {
        filename: string
        bytesReceived: number
        totalBytes: number
      }) => void): () => void => noopUnsub(),

      onDownloadChunk: (_callback: (data: {
        filename: string
        data: Uint8Array
      }) => void): () => void => noopUnsub(),

      onScanProgress: (_callback: (data: {
        current: number
        total: number
      }) => void): () => void => noopUnsub(),
    },

    // -----------------------------------------------------------------------
    // downloadService.* — 18 PHASE-1 method stubs (onStateUpdate is in events.ts)
    // -----------------------------------------------------------------------
    downloadService: {
      getState: (): Promise<{
        queue: Array<{
          id: string
          filename: string
          fileSize: number
          progress: number
          status: 'pending' | 'downloading' | 'completed' | 'failed' | 'cancelled'
          error?: string
        }>
        session: {
          id: string
          totalFiles: number
          completedFiles: number
          failedFiles: number
          status: 'active' | 'completed' | 'cancelled' | 'failed'
        } | null
        isProcessing: boolean
        isPaused: boolean
      }> => phase1Reject(),

      isFileSynced: (_filename: string): Promise<{ synced: boolean; reason: string }> => phase1Reject(),

      getFilesToSync: (
        _files: Array<{ filename: string; size: number; duration: number; dateCreated: string | Date }>,
        _opts?: { auto?: boolean; deviceSerial?: string },
      ): Promise<Array<{ filename: string; size: number; duration: number; dateCreated: string | Date; skipReason?: string }>> =>
        phase1Reject(),

      ensureBaseline: (_deviceSerial: string, _filenames: string[]): Promise<{ created: boolean }> => phase1Reject(),

      queueDownloads: (_files: Array<{ filename: string; size: number; dateCreated?: string }>): Promise<string[]> =>
        phase1Reject(),

      startSession: (_files: Array<{ filename: string; size: number; dateCreated?: string }>): Promise<{
        id: string
        totalFiles: number
        completedFiles: number
        failedFiles: number
        status: 'active' | 'completed' | 'cancelled' | 'failed'
      }> => phase1Reject(),

      processDownload: (
        _filename: string,
        _data: number[] | Uint8Array,
      ): Promise<{ success: boolean; filePath?: string; error?: string }> => phase1Reject(),

      updateProgress: (_filename: string, _bytesReceived: number): Promise<void> => phase1Reject(),

      markFailed: (_filename: string, _error: string): Promise<void> => phase1Reject(),

      clearCompleted: (): Promise<void> => phase1Reject(),

      cancel: (_filename: string): Promise<{ success: boolean; error?: string }> => phase1Reject(),

      cancelAll: (): Promise<void> => phase1Reject(),

      retryFailed: (_deviceConnected?: boolean): Promise<{ count: number; error?: string }> => phase1Reject(),

      getStats: (): Promise<{ totalSynced: number; pendingInQueue: number; failedInQueue: number }> => phase1Reject(),

      checkStalled: (): Promise<number> => phase1Reject(),

      cancelActive: (_reason?: string): Promise<number> => phase1Reject(),

      cancelPendingDownloads: (): Promise<number> => phase1Reject(),

      notifyCompletion: (_stats: { completed: number; failed: number; aborted: boolean }): Promise<void> =>
        phase1Reject(),
    },
  }
}

export type DeviceGroup = ReturnType<typeof makeDeviceGroup>
