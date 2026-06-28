/**
 * device.test.ts — Shape-assertion tests for the device stubs SDK group (Task 9 / PHASE-1).
 *
 * Asserts:
 *   1. Every jensen.* method exists and rejects with the PHASE-1 error message.
 *   2. Every jensen.on* method returns a callable no-op unsubscribe function.
 *   3. Every downloadService.* method exists and rejects with the PHASE-1 error message.
 *      (onStateUpdate is NOT in this group — it lives in events.ts)
 *
 * No HTTP mocking is needed because these are all stubs with no fetch calls.
 */

import { describe, it, expect } from 'vitest'
import { makeDeviceGroup } from '../groups/device'

const PHASE1_ERROR = 'device path is Phase 1'

describe('makeDeviceGroup — jensen stubs', () => {
  const { jensen } = makeDeviceGroup()

  // -------------------------------------------------------------------------
  // Core methods — reject with Phase 1 marker
  // -------------------------------------------------------------------------

  it('connect rejects with phase1 error', async () => {
    await expect(jensen.connect()).rejects.toThrow(PHASE1_ERROR)
  })

  it('tryConnect rejects with phase1 error', async () => {
    await expect(jensen.tryConnect()).rejects.toThrow(PHASE1_ERROR)
  })

  it('disconnect rejects with phase1 error', async () => {
    await expect(jensen.disconnect()).rejects.toThrow(PHASE1_ERROR)
  })

  it('reset rejects with phase1 error', async () => {
    await expect(jensen.reset()).rejects.toThrow(PHASE1_ERROR)
  })

  it('isConnected rejects with phase1 error', async () => {
    await expect(jensen.isConnected()).rejects.toThrow(PHASE1_ERROR)
  })

  it('getModel rejects with phase1 error', async () => {
    await expect(jensen.getModel()).rejects.toThrow(PHASE1_ERROR)
  })

  it('isP1Device rejects with phase1 error', async () => {
    await expect(jensen.isP1Device()).rejects.toThrow(PHASE1_ERROR)
  })

  // -------------------------------------------------------------------------
  // Device info & settings
  // -------------------------------------------------------------------------

  it('getDeviceInfo rejects with phase1 error', async () => {
    await expect(jensen.getDeviceInfo()).rejects.toThrow(PHASE1_ERROR)
  })

  it('getCardInfo rejects with phase1 error', async () => {
    await expect(jensen.getCardInfo()).rejects.toThrow(PHASE1_ERROR)
  })

  it('getFileCount rejects with phase1 error', async () => {
    await expect(jensen.getFileCount()).rejects.toThrow(PHASE1_ERROR)
  })

  it('getSettings rejects with phase1 error', async () => {
    await expect(jensen.getSettings()).rejects.toThrow(PHASE1_ERROR)
  })

  it('setTime rejects with phase1 error', async () => {
    await expect(jensen.setTime()).rejects.toThrow(PHASE1_ERROR)
  })

  it('setAutoRecord rejects with phase1 error', async () => {
    await expect(jensen.setAutoRecord(true)).rejects.toThrow(PHASE1_ERROR)
  })

  // -------------------------------------------------------------------------
  // File operations
  // -------------------------------------------------------------------------

  it('listFiles rejects with phase1 error', async () => {
    await expect(jensen.listFiles()).rejects.toThrow(PHASE1_ERROR)
  })

  it('downloadFile rejects with phase1 error', async () => {
    await expect(jensen.downloadFile('test.wav', 1024)).rejects.toThrow(PHASE1_ERROR)
  })

  it('cancelDownload rejects with phase1 error', async () => {
    await expect(jensen.cancelDownload()).rejects.toThrow(PHASE1_ERROR)
  })

  it('deleteFile rejects with phase1 error', async () => {
    await expect(jensen.deleteFile('test.wav')).rejects.toThrow(PHASE1_ERROR)
  })

  it('formatCard rejects with phase1 error', async () => {
    await expect(jensen.formatCard()).rejects.toThrow(PHASE1_ERROR)
  })

  // -------------------------------------------------------------------------
  // Realtime
  // -------------------------------------------------------------------------

  it('getRealtimeSettings rejects with phase1 error', async () => {
    await expect(jensen.getRealtimeSettings()).rejects.toThrow(PHASE1_ERROR)
  })

  it('startRealtime rejects with phase1 error', async () => {
    await expect(jensen.startRealtime()).rejects.toThrow(PHASE1_ERROR)
  })

  it('pauseRealtime rejects with phase1 error', async () => {
    await expect(jensen.pauseRealtime()).rejects.toThrow(PHASE1_ERROR)
  })

  it('stopRealtime rejects with phase1 error', async () => {
    await expect(jensen.stopRealtime()).rejects.toThrow(PHASE1_ERROR)
  })

  it('getRealtimeData rejects with phase1 error', async () => {
    await expect(jensen.getRealtimeData(0)).rejects.toThrow(PHASE1_ERROR)
  })

  // -------------------------------------------------------------------------
  // Battery & Bluetooth
  // -------------------------------------------------------------------------

  it('getBatteryStatus rejects with phase1 error', async () => {
    await expect(jensen.getBatteryStatus()).rejects.toThrow(PHASE1_ERROR)
  })

  it('startBluetoothScan rejects with phase1 error', async () => {
    await expect(jensen.startBluetoothScan()).rejects.toThrow(PHASE1_ERROR)
  })

  it('stopBluetoothScan rejects with phase1 error', async () => {
    await expect(jensen.stopBluetoothScan()).rejects.toThrow(PHASE1_ERROR)
  })

  it('getBluetoothStatus rejects with phase1 error', async () => {
    await expect(jensen.getBluetoothStatus()).rejects.toThrow(PHASE1_ERROR)
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

  it('getState rejects with phase1 error', async () => {
    await expect(downloadService.getState()).rejects.toThrow(PHASE1_ERROR)
  })

  it('isFileSynced rejects with phase1 error', async () => {
    await expect(downloadService.isFileSynced('test.wav')).rejects.toThrow(PHASE1_ERROR)
  })

  it('getFilesToSync rejects with phase1 error', async () => {
    await expect(
      downloadService.getFilesToSync([{ filename: 'test.wav', size: 1024, duration: 60, dateCreated: new Date() }]),
    ).rejects.toThrow(PHASE1_ERROR)
  })

  it('ensureBaseline rejects with phase1 error', async () => {
    await expect(downloadService.ensureBaseline('SN123', ['test.wav'])).rejects.toThrow(PHASE1_ERROR)
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

  it('cancelAll rejects with phase1 error', async () => {
    await expect(downloadService.cancelAll()).rejects.toThrow(PHASE1_ERROR)
  })

  it('retryFailed rejects with phase1 error', async () => {
    await expect(downloadService.retryFailed()).rejects.toThrow(PHASE1_ERROR)
  })

  it('getStats rejects with phase1 error', async () => {
    await expect(downloadService.getStats()).rejects.toThrow(PHASE1_ERROR)
  })

  it('checkStalled rejects with phase1 error', async () => {
    await expect(downloadService.checkStalled()).rejects.toThrow(PHASE1_ERROR)
  })

  it('cancelActive rejects with phase1 error', async () => {
    await expect(downloadService.cancelActive()).rejects.toThrow(PHASE1_ERROR)
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
