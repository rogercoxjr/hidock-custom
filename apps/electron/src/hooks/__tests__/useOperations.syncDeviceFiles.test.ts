import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))
vi.mock('@/hooks/useDownloadOrchestrator', () => ({
  cancelDownloads: vi.fn(), cancelDownloadsComplete: vi.fn(), processPendingDownloads: vi.fn(),
}))
vi.mock('@/store/features/useTranscriptionStore', () => ({
  useTranscriptionStore: vi.fn((sel: any) => {
    const state = { addToQueue: vi.fn(), remove: vi.fn(), clear: vi.fn(), queue: new Map() }
    return typeof sel === 'function' ? sel(state) : state
  }),
}))
import { useOperations } from '../useOperations'
import { isDownloadInFlight } from '@/services/download-guard'

const syncFile = vi.fn().mockResolvedValue({ recordingId: 'r1', status: 'synced' })
const deviceFileSource = vi.fn().mockImplementation((filename: string, size: number) => ({
  filename, size, async *stream() { /* no chunks needed — syncFile is mocked */ }
}))

describe('useOperations.syncDeviceFiles', () => {
  beforeEach(() => {
    syncFile.mockClear(); deviceFileSource.mockClear()
    ;(window as any).electronAPI = { downloadService: { deviceFileSource }, deviceSync: { syncFile } }
  })

  it('serially syncs each file via deviceFileSource + deviceSync.syncFile', async () => {
    const { result } = renderHook(() => useOperations())
    const files = [
      { filename: 'A.hda', size: 3 },
      { filename: 'B.hda', size: 5 },
    ]
    let count: number | undefined
    await act(async () => { count = await result.current.syncDeviceFiles(files) })

    expect(count).toBe(2)
    expect(deviceFileSource).toHaveBeenCalledTimes(2)
    expect(deviceFileSource).toHaveBeenNthCalledWith(1, 'A.hda', 3)
    expect(deviceFileSource).toHaveBeenNthCalledWith(2, 'B.hda', 5)
    expect(syncFile).toHaveBeenCalledTimes(2)
  })

  it('raises the download guard while syncing and clears it afterward (Tier 1 churn guard)', async () => {
    let inFlightDuringSync = false
    syncFile.mockImplementationOnce(async () => {
      inFlightDuringSync = isDownloadInFlight()
      return { recordingId: 'r1', status: 'synced' }
    })
    const { result } = renderHook(() => useOperations())
    expect(isDownloadInFlight()).toBe(false)
    await act(async () => { await result.current.syncDeviceFiles([{ filename: 'A.hda', size: 3 }]) })
    expect(inFlightDuringSync).toBe(true) // guard up during the read → refresh/poll defer
    expect(isDownloadInFlight()).toBe(false) // and cleared after (finally)
  })

  it('continues past a per-file error and returns the successful count', async () => {
    syncFile.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ recordingId: 'r2', status: 'synced' })
    const { result } = renderHook(() => useOperations())
    const files = [
      { filename: 'A.hda', size: 3 },
      { filename: 'B.hda', size: 5 },
    ]
    let count: number | undefined
    await act(async () => { count = await result.current.syncDeviceFiles(files) })

    expect(count).toBe(1)
    expect(syncFile).toHaveBeenCalledTimes(2)
  })

  it('drives deviceSyncState + downloadQueue during a sync and clears on completion', async () => {
    const { useAppStore } = await import('@/store/useAppStore')
    const seen: Array<{ stage: unknown; queued: boolean; syncing: boolean }> = []
    syncFile.mockImplementationOnce(async (_src: any, onProgress?: (p: any) => void) => {
      onProgress?.({ stage: 'reading', loaded: 3, total: 3 })
      const s = useAppStore.getState()
      seen.push({ stage: s.deviceFileStage, queued: s.downloadQueue.has('A.hda'), syncing: s.deviceSyncing })
      return { recordingId: 'r1', status: 'synced' }
    })
    const { result } = renderHook(() => useOperations())
    await act(async () => { await result.current.syncDeviceFiles([{ filename: 'A.hda', size: 3 }]) })

    expect(seen[0]).toEqual({ stage: 'reading', queued: true, syncing: true })
    const after = useAppStore.getState()
    expect(after.deviceSyncing).toBe(false)
    expect(after.downloadQueue.has('A.hda')).toBe(false)
    expect(after.deviceFileStage).toBeNull()
  })
})
