/**
 * device.ts — renderer device SDK group (jensen.* + downloadService.*, minus onStateUpdate).
 *
 * Un-stubbed (Task 9): jensen.* methods that have a real `JensenDevice` counterpart now
 * delegate to a shared `JensenDevice` instance over real WebUSB. Methods with NO counterpart
 * on `JensenDevice` (no aggregate event bus, no standalone cancel-in-flight primitive) remain
 * `phase1Reject` / `noopUnsub` stubs — see the per-method comments below for why.
 *
 * `downloadService.*` (queue/session orchestration) has no web-renderer implementation yet —
 * all 18 of its methods stay Phase-1 stubs. The one addition is `deviceFileSource()` (SEAM 1,
 * `types-device-sync.ts`), which exposes a single device file as an async-iterable byte stream
 * for the device-sync upload client (`device-sync-client.ts`) to consume.
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

import { getJensenDevice, type JensenDevice } from '../../../services/jensen'
import type { DeviceFileSource } from '../types-device-sync'

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
  // Share the app-wide singleton JensenDevice instance rather than constructing a new one.
  // Two separate JensenDevice instances would each call claimInterface(0) on the same
  // physical HiDock over WebUSB, producing LIBUSB_ERROR_ACCESS device lockups (see
  // CLAUDE.md "USB Device Safety"). The real connect path (pages/Device.tsx ->
  // hidock-device.ts) also uses getJensenDevice(), so this keeps a single owner of the
  // USB connection across the whole renderer.
  const dev = getJensenDevice()

  return {
    // -----------------------------------------------------------------------
    // jensen.* — real delegation to JensenDevice where a counterpart exists;
    // phase1Reject / noopUnsub otherwise (see comments).
    // -----------------------------------------------------------------------
    jensen: {
      // Core
      connect: (signal?: AbortSignal): Promise<boolean> => dev.connect(signal),
      tryConnect: (preAuthorized?: USBDevice): Promise<boolean> => dev.tryConnect(preAuthorized),
      disconnect: (): Promise<void> => dev.disconnect(),
      reset: (): Promise<boolean> => dev.reset(),
      isConnected: (): Promise<boolean> => Promise.resolve(dev.isConnected()),
      getModel: (): Promise<string | null> => Promise.resolve(dev.getModel()),
      isP1Device: (): Promise<boolean> => Promise.resolve(dev.isP1Device()),

      // Device info & settings
      getDeviceInfo: (timeout?: number): ReturnType<JensenDevice['getDeviceInfo']> => dev.getDeviceInfo(timeout),
      getCardInfo: (timeout?: number): ReturnType<JensenDevice['getCardInfo']> => dev.getCardInfo(timeout),
      getFileCount: (timeout?: number): Promise<{ count: number } | null> => dev.getFileCount(timeout),
      getSettings: (timeout?: number): ReturnType<JensenDevice['getSettings']> => dev.getSettings(timeout),
      // Real setTime() requires a Date; default to "now" so the Phase-1 zero-arg call shape
      // (`jensen.setTime()`) keeps working for callers that just want to sync the clock.
      setTime: (date?: Date, timeout?: number): ReturnType<JensenDevice['setTime']> =>
        dev.setTime(date ?? new Date(), timeout),
      setAutoRecord: (enabled: boolean, timeout?: number): ReturnType<JensenDevice['setAutoRecord']> =>
        dev.setAutoRecord(enabled, timeout),

      // File operations
      listFiles: (
        onProgress?: (filesFound: number, expectedFiles: number) => void,
        expectedFileCount?: number,
        onNewFiles?: (files: unknown[]) => void,
      ): ReturnType<JensenDevice['listFiles']> =>
        dev.listFiles(onProgress, expectedFileCount, onNewFiles as never),
      // Real downloadFile() requires an onChunk callback; default to a no-op sink so callers
      // that only care about the completion boolean (the Phase-1 call shape) still work.
      // Streaming consumers should use downloadService.deviceFileSource() instead, which wires
      // a real onChunk to drain an async iterable.
      downloadFile: (
        filename: string,
        fileSize: number,
        onChunk?: (data: Uint8Array) => void,
        onProgress?: (received: number) => void,
        signal?: AbortSignal,
      ): Promise<boolean> => dev.downloadFile(filename, fileSize, onChunk ?? noop, onProgress, signal),
      // No JensenDevice counterpart: cancellation is expressed via the AbortSignal passed into
      // downloadFile() itself, not a standalone "cancel the in-flight transfer" method — there
      // is no device-level handle here to cancel without fabricating extra state. Stays Phase-1.
      cancelDownload: (): Promise<void> => phase1Reject(),
      deleteFile: (filename: string, timeout?: number): ReturnType<JensenDevice['deleteFile']> =>
        dev.deleteFile(filename, timeout),
      formatCard: (timeout?: number): ReturnType<JensenDevice['formatCard']> => dev.formatCard(timeout),

      // Realtime
      getRealtimeSettings: (timeout?: number): ReturnType<JensenDevice['getRealtimeSettings']> =>
        dev.getRealtimeSettings(timeout),
      startRealtime: (timeout?: number): ReturnType<JensenDevice['startRealtime']> => dev.startRealtime(timeout),
      pauseRealtime: (timeout?: number): ReturnType<JensenDevice['pauseRealtime']> => dev.pauseRealtime(timeout),
      stopRealtime: (timeout?: number): ReturnType<JensenDevice['stopRealtime']> => dev.stopRealtime(timeout),
      getRealtimeData: (offset: number, timeout?: number): ReturnType<JensenDevice['getRealtimeData']> =>
        dev.getRealtimeData(offset, timeout),

      // Battery & Bluetooth
      getBatteryStatus: (timeout?: number): ReturnType<JensenDevice['getBatteryStatus']> =>
        dev.getBatteryStatus(timeout),
      startBluetoothScan: (duration?: number, timeout?: number): ReturnType<JensenDevice['startBluetoothScan']> =>
        dev.startBluetoothScan(duration, timeout),
      stopBluetoothScan: (timeout?: number): ReturnType<JensenDevice['stopBluetoothScan']> =>
        dev.stopBluetoothScan(timeout),
      getBluetoothStatus: (timeout?: number): ReturnType<JensenDevice['getBluetoothStatus']> =>
        dev.getBluetoothStatus(timeout),

      // Push event subscriptions (6 on* events) — NO JensenDevice counterpart for any of these:
      // `JensenDevice` exposes single-slot `onconnect`/`ondisconnect` callback properties (last
      // writer wins, no unsubscribe semantics) rather than a multi-subscriber event bus, and has
      // no aggregate state-changed / download-chunk / download-progress / scan-progress emitters
      // at all (downloadFile()/listFiles() take *per-call* onChunk/onProgress callbacks, not
      // subscribable events). Wiring a real pub-sub layer on top is connect/reconnect-gesture
      // work for a later task, not a straight delegation — stays Phase-1 here.
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
    // downloadService.* — queue/session orchestration has no renderer implementation yet, so
    // all 18 method stubs stay Phase-1 (onStateUpdate is in events.ts). The one real addition
    // is deviceFileSource(), which exposes a device file as a DeviceFileSource (SEAM 1).
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

      /**
       * SEAM 1 — exposes a single device file as an async-iterable byte stream for the
       * device-sync upload client (`device-sync-client.ts`). Drains `JensenDevice.downloadFile`'s
       * per-chunk `onChunk` callback into the stream via a promise-signalled queue (no polling):
       * a waiting `stream()` iteration is woken exactly when a chunk arrives or the underlying
       * download settles, so the generator can't spin and can't hang once `downloadFile`
       * resolves/rejects.
       */
      deviceFileSource(filename: string, size: number): DeviceFileSource {
        return {
          filename,
          size,
          async *stream() {
            const queue: Uint8Array[] = []
            let wake: (() => void) | null = null
            let finished = false
            let failure: Error | null = null

            const notify = (): void => {
              if (wake) {
                const fn = wake
                wake = null
                fn()
              }
            }

            const donePromise = dev
              .downloadFile(filename, size, (chunk) => {
                queue.push(chunk)
                notify()
              })
              .then((ok) => {
                finished = true
                if (!ok) failure = new Error(`deviceFileSource: downloadFile failed for ${filename}`)
                notify()
              })
              .catch((err: unknown) => {
                finished = true
                failure = err instanceof Error ? err : new Error(String(err))
                notify()
              })

            try {
              for (;;) {
                if (queue.length > 0) {
                  yield queue.shift() as Uint8Array
                  continue
                }
                if (finished) {
                  if (failure) throw failure
                  return
                }
                // Suspend until the next chunk arrives or the download settles — no polling.
                await new Promise<void>((resolve) => {
                  wake = resolve
                })
              }
            } finally {
              // If the consumer stops early (e.g. `break`), still observe the download promise
              // so a late failure doesn't surface as an unhandled rejection.
              await donePromise.catch(() => {})
            }
          },
        }
      },
    },
  }
}

export type DeviceGroup = ReturnType<typeof makeDeviceGroup>
