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

const syncFile = vi.fn().mockResolvedValue({ recordingId: 'r1', status: 'synced' })
const deviceFileSource = vi.fn().mockReturnValue({
  filename: 'REC1.hda', size: 3, async *stream() { /* no chunks needed — syncFile is mocked */ }
})

describe('useOperations.queueDownload (device sync)', () => {
  beforeEach(() => {
    syncFile.mockClear(); deviceFileSource.mockClear()
    ;(window as any).electronAPI = { downloadService: { deviceFileSource }, deviceSync: { syncFile } }
  })

  it('syncs a device-only recording via deviceSync.syncFile', async () => {
    const { result } = renderHook(() => useOperations())
    const rec: any = {
      id: 'x', filename: 'REC1.hda', deviceFilename: 'REC1.hda', size: 3,
      location: 'device-only', dateRecorded: new Date(),
    }
    let ok: boolean | undefined
    await act(async () => { ok = await result.current.queueDownload(rec) })
    expect(ok).toBe(true)
    expect(deviceFileSource).toHaveBeenCalledWith('REC1.hda', 3)
    expect(syncFile).toHaveBeenCalledTimes(1)
  })

  it('returns false for a non-device-only recording', async () => {
    const { result } = renderHook(() => useOperations())
    const rec: any = { id: 'y', filename: 'L.wav', location: 'local-only', dateRecorded: new Date() }
    let ok: boolean | undefined
    await act(async () => { ok = await result.current.queueDownload(rec) })
    expect(ok).toBe(false)
    expect(syncFile).not.toHaveBeenCalled()
  })
})
