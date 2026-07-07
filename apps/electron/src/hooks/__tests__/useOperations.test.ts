import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useOperations } from '../useOperations'

// Mock toast
vi.mock('@/components/ui/toaster', () => ({
  toast: vi.fn()
}))

// Mock useDownloadOrchestrator
vi.mock('@/hooks/useDownloadOrchestrator', () => ({
  cancelDownloads: vi.fn(),
  cancelDownloadsComplete: vi.fn(),
  processPendingDownloads: vi.fn()
}))

// Mock transcription store
const mockAddToQueue = vi.fn()
const mockRemove = vi.fn()
const mockClear = vi.fn()
vi.mock('@/store/features/useTranscriptionStore', () => ({
  useTranscriptionStore: vi.fn((selector) => {
    const state = {
      addToQueue: mockAddToQueue,
      remove: mockRemove,
      clear: mockClear,
      queue: new Map()
    }
    if (typeof selector === 'function') return selector(state)
    return state
  })
}))

// Need to also mock the static getState method
import { useTranscriptionStore } from '@/store/features/useTranscriptionStore'
;(useTranscriptionStore as any).getState = vi.fn(() => ({
  remove: mockRemove,
  clear: mockClear
}))

// Mock electronAPI
const mockUpdateStatus = vi.fn().mockResolvedValue(undefined)
const mockCancelTranscription = vi.fn().mockResolvedValue(undefined)
const mockCancelAllTranscriptions = vi.fn().mockResolvedValue({ count: 3 })
const mockQueueDownloads = vi.fn().mockResolvedValue(undefined)
const mockCancelAllDownloads = vi.fn().mockResolvedValue(undefined)
// Task 11: queueDownload/queueBulkDownloads now route through the device sync client
// instead of the stubbed downloadService.queueDownloads.
const mockDeviceFileSource = vi.fn((filename: string, size: number) => ({
  filename, size, async *stream() { /* no chunks needed — syncFile is mocked */ }
}))
const mockSyncFile = vi.fn().mockResolvedValue({ recordingId: 'r1', status: 'synced' })

const mockAddToQueueIPC = vi.fn().mockResolvedValue('queue-item-1')
// AC6 forced re-transcribe routes through recordings.transcribe (the clearing IPC),
// which returns the queue-item id just like addToQueue.
const mockTranscribeIPC = vi.fn().mockResolvedValue('queue-item-1')
// spec §5.6: validateTranscriptionConfig replaces the hardcoded Gemini-key gates
const mockValidateTranscriptionConfig = vi.fn().mockResolvedValue({ ok: true, problems: [] })

global.window.electronAPI = {
  recordings: {
    updateStatus: mockUpdateStatus,
    addToQueue: mockAddToQueueIPC,
    transcribe: mockTranscribeIPC,
    cancelTranscription: mockCancelTranscription,
    cancelAllTranscriptions: mockCancelAllTranscriptions,
    validateTranscriptionConfig: mockValidateTranscriptionConfig
  },
  downloadService: {
    queueDownloads: mockQueueDownloads,
    cancelAll: mockCancelAllDownloads,
    deviceFileSource: mockDeviceFileSource
  },
  deviceSync: {
    syncFile: mockSyncFile
  }
} as any

describe('useOperations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('queueTranscription', () => {
    it('returns false for device-only recordings without local path', async () => {
      const { result } = renderHook(() => useOperations())

      const deviceOnly = {
        id: 'rec-1',
        filename: 'REC0001.WAV',
        location: 'device-only' as const,
        deviceFilename: 'REC0001.WAV',
        syncStatus: 'not-synced' as const,
        transcriptionStatus: 'none' as const,
        size: 1024,
        duration: 60,
        dateRecorded: new Date()
      }

      let success: boolean | undefined
      await act(async () => {
        success = await result.current.queueTranscription(deviceOnly as any)
      })

      expect(success).toBe(false)
      expect(mockUpdateStatus).not.toHaveBeenCalled()
    })

    it('returns false for already processing recordings', async () => {
      const { result } = renderHook(() => useOperations())

      const processing = {
        id: 'rec-2',
        filename: 'test.wav',
        location: 'local-only' as const,
        localPath: '/path/test.wav',
        syncStatus: 'synced' as const,
        transcriptionStatus: 'processing' as const,
        size: 1024,
        duration: 60,
        dateRecorded: new Date()
      }

      let success: boolean | undefined
      await act(async () => {
        success = await result.current.queueTranscription(processing as any)
      })

      expect(success).toBe(false)
    })

    it('queues transcription for eligible local recording', async () => {
      const { result } = renderHook(() => useOperations())

      const eligible = {
        id: 'rec-3',
        filename: 'eligible.wav',
        location: 'local-only' as const,
        localPath: '/path/eligible.wav',
        syncStatus: 'synced' as const,
        transcriptionStatus: 'none' as const,
        size: 1024,
        duration: 60,
        dateRecorded: new Date()
      }

      let success: boolean | undefined
      await act(async () => {
        success = await result.current.queueTranscription(eligible as any)
      })

      expect(success).toBe(true)
      expect(mockUpdateStatus).toHaveBeenCalledWith('rec-3', 'pending')
      expect(mockAddToQueueIPC).toHaveBeenCalledWith('rec-3')
      expect(mockAddToQueue).toHaveBeenCalledWith('queue-item-1', 'rec-3', 'eligible.wav')
      // A first-time/non-forced transcribe must NOT use the re-transcribe clearing IPC.
      expect(mockTranscribeIPC).not.toHaveBeenCalled()
    })

    it('returns false for a complete recording WITHOUT force (re-transcribe dead-path guard)', async () => {
      const { result } = renderHook(() => useOperations())

      const complete = {
        id: 'rec-complete',
        filename: 'done.wav',
        location: 'local-only' as const,
        localPath: '/path/done.wav',
        syncStatus: 'synced' as const,
        transcriptionStatus: 'complete' as const,
        size: 1024,
        duration: 60,
        dateRecorded: new Date()
      }

      let success: boolean | undefined
      await act(async () => {
        success = await result.current.queueTranscription(complete as any)
      })

      expect(success).toBe(false)
      expect(mockUpdateStatus).not.toHaveBeenCalled()
      expect(mockAddToQueueIPC).not.toHaveBeenCalled()
    })

    it('re-queues a complete recording WITH force:true via the CLEARING IPC, not bare addToQueue (AC6)', async () => {
      const { result } = renderHook(() => useOperations())

      const complete = {
        id: 'rec-complete-2',
        filename: 'redo.wav',
        location: 'local-only' as const,
        localPath: '/path/redo.wav',
        syncStatus: 'synced' as const,
        transcriptionStatus: 'complete' as const,
        size: 1024,
        duration: 60,
        dateRecorded: new Date()
      }

      let success: boolean | undefined
      await act(async () => {
        success = await result.current.queueTranscription(complete as any, { force: true })
      })

      expect(success).toBe(true)
      expect(mockUpdateStatus).toHaveBeenCalledWith('rec-complete-2', 'pending')
      // AC6 / the live-run bug: a forced re-transcribe MUST route through
      // recordings.transcribe — the ONLY path that clears the stage markers + drops
      // prior speaker mappings server-side before enqueueing. The bare addToQueue path
      // skips that clear, so the worker sees full_text+summarization_provider and
      // short-circuits ("already fully transcribed") → re-transcribe silently no-ops.
      expect(mockTranscribeIPC).toHaveBeenCalledWith('rec-complete-2')
      expect(mockAddToQueueIPC).not.toHaveBeenCalled()
      // The returned queue-item id still feeds the in-app queue panel.
      expect(mockAddToQueue).toHaveBeenCalledWith('queue-item-1', 'rec-complete-2', 'redo.wav')
    })

    it('returns false for a processing recording EVEN WITH force:true (never double-queue)', async () => {
      const { result } = renderHook(() => useOperations())

      const processing = {
        id: 'rec-processing-force',
        filename: 'busy.wav',
        location: 'local-only' as const,
        localPath: '/path/busy.wav',
        syncStatus: 'synced' as const,
        transcriptionStatus: 'processing' as const,
        size: 1024,
        duration: 60,
        dateRecorded: new Date()
      }

      let success: boolean | undefined
      await act(async () => {
        success = await result.current.queueTranscription(processing as any, { force: true })
      })

      expect(success).toBe(false)
      expect(mockUpdateStatus).not.toHaveBeenCalled()
      expect(mockAddToQueueIPC).not.toHaveBeenCalled()
    })

    it('returns false and toasts provider name when validateTranscriptionConfig reports missing key (spec §5.6)', async () => {
      // spec §5.6: preflight is provider-aware — Whisper user gets "openai-whisper" in the toast
      mockValidateTranscriptionConfig.mockResolvedValueOnce({
        ok: false,
        problems: [{ stage: 'asr', provider: 'openai-whisper', problem: 'missing-key' }]
      })
      const { toast } = await import('@/components/ui/toaster')
      const { result } = renderHook(() => useOperations())

      const eligible = {
        id: 'rec-7',
        filename: 'test.wav',
        location: 'local-only' as const,
        localPath: '/path/test.wav',
        syncStatus: 'synced' as const,
        transcriptionStatus: 'none' as const,
        size: 1024,
        duration: 60,
        dateRecorded: new Date()
      }

      let success: boolean | undefined
      await act(async () => {
        success = await result.current.queueTranscription(eligible as any)
      })

      expect(success).toBe(false)
      expect(mockUpdateStatus).not.toHaveBeenCalled()
      expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.objectContaining({
        description: expect.stringContaining('openai-whisper')
      }))
    })

    it('returns false and toasts config error when validateTranscriptionConfig throws (spec §5.6)', async () => {
      mockValidateTranscriptionConfig.mockRejectedValueOnce(new Error('IPC error'))
      const { toast } = await import('@/components/ui/toaster')
      const { result } = renderHook(() => useOperations())

      const eligible = {
        id: 'rec-8',
        filename: 'test.wav',
        location: 'local-only' as const,
        localPath: '/path/test.wav',
        syncStatus: 'synced' as const,
        transcriptionStatus: 'none' as const,
        size: 1024,
        duration: 60,
        dateRecorded: new Date()
      }

      let success: boolean | undefined
      await act(async () => {
        success = await result.current.queueTranscription(eligible as any)
      })

      expect(success).toBe(false)
      expect(mockUpdateStatus).not.toHaveBeenCalled()
      expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Configuration error'
      }))
    })
  })

  describe('queueDownload', () => {
    it('returns false for non-device-only recordings', async () => {
      const { result } = renderHook(() => useOperations())

      const localOnly = {
        id: 'rec-4',
        location: 'local-only' as const,
        localPath: '/path/test.wav',
        syncStatus: 'synced' as const,
        transcriptionStatus: 'none' as const,
        filename: 'test.wav',
        size: 1024,
        duration: 60,
        dateRecorded: new Date()
      }

      let success: boolean | undefined
      await act(async () => {
        success = await result.current.queueDownload(localOnly as any)
      })

      expect(success).toBe(false)
      expect(mockQueueDownloads).not.toHaveBeenCalled()
    })

    it('syncs device-only recording via the device sync client (Task 11)', async () => {
      const { result } = renderHook(() => useOperations())

      const deviceOnly = {
        id: 'rec-5',
        filename: 'REC0005.WAV',
        location: 'device-only' as const,
        deviceFilename: 'REC0005.WAV',
        syncStatus: 'not-synced' as const,
        transcriptionStatus: 'none' as const,
        size: 2048,
        duration: 120,
        dateRecorded: new Date('2026-01-15')
      }

      let success: boolean | undefined
      await act(async () => {
        success = await result.current.queueDownload(deviceOnly as any)
      })

      expect(success).toBe(true)
      // Task 11: routes through downloadService.deviceFileSource + deviceSync.syncFile
      // instead of the stubbed queueDownloads (which rejects in hosted mode).
      expect(mockDeviceFileSource).toHaveBeenCalledWith('REC0005.WAV', 2048)
      expect(mockSyncFile).toHaveBeenCalledTimes(1)
      expect(mockQueueDownloads).not.toHaveBeenCalled()
    })

    it('does not touch the device sync client when the recording is not device-only', async () => {
      const { result } = renderHook(() => useOperations())

      const localOnly = {
        id: 'rec-6b',
        location: 'local-only' as const,
        localPath: '/p.wav',
        syncStatus: 'synced' as const,
        transcriptionStatus: 'none' as const,
        filename: 'p.wav',
        size: 1,
        duration: 1,
        dateRecorded: new Date()
      }

      await act(async () => {
        await result.current.queueDownload(localOnly as any)
      })

      expect(mockDeviceFileSource).not.toHaveBeenCalled()
      expect(mockSyncFile).not.toHaveBeenCalled()
    })
  })

  describe('queueBulkDownloads', () => {
    it('syncs eligible device-only recordings serially via the device sync client (Task 11)', async () => {
      const { result } = renderHook(() => useOperations())

      const recs = [
        {
          id: 'b1', filename: 'B1.WAV', location: 'device-only' as const, deviceFilename: 'B1.WAV',
          syncStatus: 'not-synced' as const, transcriptionStatus: 'none' as const,
          size: 10, duration: 5, dateRecorded: new Date('2026-03-01')
        },
        {
          id: 'b2', filename: 'B2.WAV', location: 'local-only' as const, localPath: '/b2.wav',
          syncStatus: 'synced' as const, transcriptionStatus: 'none' as const,
          size: 10, duration: 5, dateRecorded: new Date('2026-03-02')
        }
      ]

      let count: number | undefined
      await act(async () => {
        count = await result.current.queueBulkDownloads(recs as any)
      })

      expect(count).toBe(1)
      expect(mockDeviceFileSource).toHaveBeenCalledTimes(1)
      expect(mockDeviceFileSource).toHaveBeenCalledWith('B1.WAV', 10)
      expect(mockSyncFile).toHaveBeenCalledTimes(1)
    })

    it('does not touch the device sync client when nothing is eligible', async () => {
      const { result } = renderHook(() => useOperations())

      const recs = [
        {
          id: 'b3', location: 'local-only' as const, localPath: '/b3.wav', filename: 'b3.wav',
          syncStatus: 'synced' as const, transcriptionStatus: 'none' as const,
          size: 1, duration: 1, dateRecorded: new Date()
        }
      ]

      let count: number | undefined
      await act(async () => {
        count = await result.current.queueBulkDownloads(recs as any)
      })

      expect(count).toBe(0)
      expect(mockDeviceFileSource).not.toHaveBeenCalled()
      expect(mockSyncFile).not.toHaveBeenCalled()
    })
  })

  describe('cancelAllTranscriptions', () => {
    it('calls IPC and clears store', async () => {
      const { result } = renderHook(() => useOperations())

      await act(async () => {
        await result.current.cancelAllTranscriptions()
      })

      expect(mockCancelAllTranscriptions).toHaveBeenCalled()
      expect(mockClear).toHaveBeenCalled()
    })
  })

  describe('cancelAllDownloads', () => {
    it('calls IPC cancel', async () => {
      const { result } = renderHook(() => useOperations())

      await act(async () => {
        await result.current.cancelAllDownloads()
      })

      expect(mockCancelAllDownloads).toHaveBeenCalled()
    })
  })
})
