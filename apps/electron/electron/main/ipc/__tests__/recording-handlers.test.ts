/**
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ipcMain } from 'electron'
import { registerRecordingHandlers } from '../recording-handlers'

// Mock electron
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: {
    getFocusedWindow: vi.fn(),
    getAllWindows: vi.fn(() => [{}])
  }
}))

// Mock database service
vi.mock('../../services/database', () => ({
  getRecordings: vi.fn(),
  getRecordingById: vi.fn(),
  getRecordingsForMeeting: vi.fn(),
  updateRecordingStatus: vi.fn(),
  updateRecordingTranscriptionStatus: vi.fn(),
  linkRecordingToMeeting: vi.fn(),
  getTranscriptByRecordingId: vi.fn(),
  getCandidatesForRecordingWithDetails: vi.fn(),
  getMeetingsNearDate: vi.fn(),
  insertRecording: vi.fn(),
  getQueueItems: vi.fn(),
  addToQueue: vi.fn(),
  updateQueueItem: vi.fn(),
  clearTranscriptStage2Marker: vi.fn(),
  clearTranscriptForRetranscribe: vi.fn(),
  deleteRecordingSpeakersForRecording: vi.fn(),
  deleteLabelEmbeddingsForRecording: vi.fn(),
  deleteWindowEmbeddingsForRecording: vi.fn(),
  expireSuggestionsForRecording: vi.fn(),
  rependFailedItems: vi.fn().mockReturnValue(0),
  isSummaryStale: vi.fn().mockReturnValue(false)
}))

// Mock file-storage service
vi.mock('../../services/file-storage', () => ({
  getRecordingFiles: vi.fn(),
  deleteRecording: vi.fn(),
  getRecordingsPath: vi.fn(() => '/mock/recordings')
}))

// Mock node:fs - must include default export for jsdom environment
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    default: actual,
    ...actual,
    copyFileSync: vi.fn(),
    existsSync: vi.fn(),
    statSync: vi.fn()
  }
})

// Mock node:path - must include default export for jsdom environment
vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path')
  return {
    default: actual,
    ...actual
  }
})

// Mock node:crypto - must include default export for jsdom environment
vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto')
  return {
    default: actual,
    ...actual,
    randomUUID: vi.fn(() => 'generated-uuid-1234')
  }
})

// UUID regex for validation
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Helper to create a schema mock that validates UUIDs in the expected field
function createSchemaMock(idField: string | string[]) {
  const fields = Array.isArray(idField) ? idField : [idField]
  return {
    safeParse: vi.fn((data: any) => {
      for (const field of fields) {
        if (data[field] !== undefined && !UUID_RE.test(data[field])) {
          return {
            success: false,
            error: { issues: [{ message: `${field} must be a valid UUID` }] }
          }
        }
      }
      return { success: true, data }
    })
  }
}

// Mock validation schemas
vi.mock('../validation', () => ({
  GetRecordingByIdSchema: createSchemaMock('id'),
  DeleteRecordingSchema: createSchemaMock('id'),
  DeleteBatchRecordingsSchema: {
    safeParse: vi.fn((data: any) => {
      if (!data?.ids || !Array.isArray(data.ids)) {
        return { success: false, error: { issues: [{ message: 'ids must be an array' }] } }
      }
      if (data.ids.length === 0) {
        return { success: false, error: { issues: [{ message: 'ids must have at least 1 element' }] } }
      }
      if (data.ids.length > 1000) {
        return { success: false, error: { issues: [{ message: 'ids must have at most 1000 elements' }] } }
      }
      for (const id of data.ids) {
        if (!UUID_RE.test(id)) {
          return { success: false, error: { issues: [{ message: 'Each ID must be a valid UUID' }] } }
        }
      }
      return { success: true, data }
    })
  },
  LinkRecordingToMeetingSchema: createSchemaMock(['recordingId', 'meetingId']),
  UnlinkRecordingFromMeetingSchema: createSchemaMock('recordingId'),
  TranscribeRecordingSchema: createSchemaMock('recordingId'),
  UpdateRecordingStatusSchema: createSchemaMock('id'),
  UpdateTranscriptionStatusSchema: createSchemaMock('id')
}))

// Mock recording-watcher service
vi.mock('../../services/recording-watcher', () => ({
  startRecordingWatcher: vi.fn(),
  stopRecordingWatcher: vi.fn(),
  getWatcherStatus: vi.fn(() => ({ isWatching: false, path: '/mock/recordings' }))
}))

// Mock transcription service
vi.mock('../../services/transcription', () => ({
  transcribeManually: vi.fn(),
  getTranscriptionStatus: vi.fn(),
  startTranscriptionProcessor: vi.fn(),
  stopTranscriptionProcessor: vi.fn(),
  cancelTranscription: vi.fn(),
  cancelAllTranscriptions: vi.fn(),
  processQueueManually: vi.fn().mockResolvedValue(undefined)
}))

// Mock config service
vi.mock('../../services/config', () => ({
  getConfig: vi.fn(() => ({
    transcription: {
      provider: 'gemini',
      geminiApiKey: 'test-api-key',
      geminiModel: 'gemini-3-pro-preview',
      autoTranscribe: true,
      language: 'es'
    }
  })),
  setConfig: vi.fn()
}))

describe('Recording IPC Handlers', () => {
  let handlers: Record<string, (...args: any[]) => any> = {}

  beforeEach(async () => {
    vi.clearAllMocks()
    handlers = {}
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: (...args: any[]) => any) => {
      handlers[channel] = handler
      return undefined as any
    })
    registerRecordingHandlers()
  })

  it('should register all expected handlers', () => {
    const expectedChannels = [
      'recordings:getAll',
      'recordings:getById',
      'recordings:getForMeeting',
      'recordings:getAllWithTranscripts',
      'recordings:delete',
      'recordings:deleteBatch',
      'recordings:linkToMeeting',
      'recordings:unlinkFromMeeting',
      'recordings:getTranscript',
      'recordings:transcribe',
      'recordings:getWatcherStatus',
      'recordings:startWatcher',
      'recordings:stopWatcher',
      'recordings:getTranscriptionStatus',
      'recordings:startTranscriptionProcessor',
      'recordings:stopTranscriptionProcessor',
      'transcription:cancel',
      'transcription:cancelAll',
      'transcription:getQueue',
      'transcription:updateQueueItem',
      'recordings:scanFolder',
      'recordings:getCandidates',
      'recordings:getMeetingsNearDate',
      'recordings:addExternal',
      'recordings:addExternalByPath',
      'recordings:selectMeeting',
      'recordings:addToQueue',
      'recordings:processQueue',
      'transcription:retry',
      'recordings:updateStatus',
      'recordings:updateTranscriptionStatus',
      'transcription:validateConfig',
      'transcription:resummarize',
      'transcription:retryAll'
    ]

    for (const channel of expectedChannels) {
      expect(ipcMain.handle).toHaveBeenCalledWith(channel, expect.any(Function))
    }
  })

  describe('recordings:getAll', () => {
    it('should return all recordings from the database', async () => {
      const { getRecordings } = await import('../../services/database')
      const mockRecordings = [
        { id: 'rec-1', filename: 'meeting-01.wav', status: 'ready' },
        { id: 'rec-2', filename: 'meeting-02.wav', status: 'ready' }
      ]
      vi.mocked(getRecordings).mockReturnValue(mockRecordings as any)

      const result = await handlers['recordings:getAll'](null)

      expect(getRecordings).toHaveBeenCalled()
      expect(result).toEqual(mockRecordings)
    })

    it('should return empty array on error', async () => {
      const { getRecordings } = await import('../../services/database')
      vi.mocked(getRecordings).mockImplementation(() => {
        throw new Error('Database error')
      })

      const result = await handlers['recordings:getAll'](null)

      expect(result).toEqual([])
    })
  })

  describe('recordings:getById', () => {
    it('should return a recording by valid UUID', async () => {
      const { getRecordingById } = await import('../../services/database')
      const mockRecording = { id: '550e8400-e29b-41d4-a716-446655440000', filename: 'test.wav' }
      vi.mocked(getRecordingById).mockReturnValue(mockRecording as any)

      const result = await handlers['recordings:getById'](null, '550e8400-e29b-41d4-a716-446655440000')

      expect(getRecordingById).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000')
      expect(result).toEqual(mockRecording)
    })

    it('should return undefined for invalid ID format', async () => {
      const { getRecordingById } = await import('../../services/database')

      const result = await handlers['recordings:getById'](null, 'not-a-uuid')

      expect(getRecordingById).not.toHaveBeenCalled()
      expect(result).toBeUndefined()
    })

    it('should return undefined on database error', async () => {
      const { getRecordingById } = await import('../../services/database')
      vi.mocked(getRecordingById).mockImplementation(() => {
        throw new Error('Database error')
      })

      const result = await handlers['recordings:getById'](null, '550e8400-e29b-41d4-a716-446655440000')

      expect(result).toBeUndefined()
    })
  })

  describe('recordings:getForMeeting', () => {
    it('should return recordings with transcripts for a meeting', async () => {
      const { getRecordingsForMeeting, getTranscriptByRecordingId } = await import('../../services/database')
      const meetingId = '550e8400-e29b-41d4-a716-446655440000'
      const mockRecordings = [
        { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', filename: 'rec1.wav' }
      ]
      const mockTranscript = { id: 't-1', recording_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', full_text: 'Hello' }

      vi.mocked(getRecordingsForMeeting).mockReturnValue(mockRecordings as any)
      vi.mocked(getTranscriptByRecordingId).mockReturnValue(mockTranscript as any)

      const result = await handlers['recordings:getForMeeting'](null, meetingId)

      expect(getRecordingsForMeeting).toHaveBeenCalledWith(meetingId)
      expect(result).toHaveLength(1)
      expect(result[0].transcript).toEqual(mockTranscript)
    })

    it('should return empty array for invalid meeting ID', async () => {
      const result = await handlers['recordings:getForMeeting'](null, 'invalid')

      expect(result).toEqual([])
    })
  })

  describe('recordings:getAllWithTranscripts', () => {
    it('should return all recordings with their transcripts', async () => {
      const { getRecordings, getTranscriptByRecordingId } = await import('../../services/database')
      const mockRecordings = [
        { id: 'r1', filename: 'a.wav' },
        { id: 'r2', filename: 'b.wav' }
      ]
      vi.mocked(getRecordings).mockReturnValue(mockRecordings as any)
      vi.mocked(getTranscriptByRecordingId)
        .mockReturnValueOnce({ id: 't1', full_text: 'Text 1' } as any)
        .mockReturnValueOnce(undefined)

      const result = await handlers['recordings:getAllWithTranscripts'](null)

      expect(result).toHaveLength(2)
      expect(result[0].transcript).toEqual({ id: 't1', full_text: 'Text 1' })
      expect(result[1].transcript).toBeUndefined()
    })

    it('should return empty array on error', async () => {
      const { getRecordings } = await import('../../services/database')
      vi.mocked(getRecordings).mockImplementation(() => {
        throw new Error('DB failure')
      })

      const result = await handlers['recordings:getAllWithTranscripts'](null)

      expect(result).toEqual([])
    })
  })

  describe('recordings:delete', () => {
    it('should delete a recording file and update its status', async () => {
      const { getRecordingById, updateRecordingStatus } = await import('../../services/database')
      const { deleteRecording } = await import('../../services/file-storage')
      const id = '550e8400-e29b-41d4-a716-446655440000'
      vi.mocked(getRecordingById).mockReturnValue({
        id,
        file_path: '/path/to/file.wav',
        filename: 'file.wav'
      } as any)
      vi.mocked(deleteRecording).mockReturnValue(true)

      const result = await handlers['recordings:delete'](null, id)

      expect(deleteRecording).toHaveBeenCalledWith('/path/to/file.wav')
      expect(updateRecordingStatus).toHaveBeenCalledWith(id, 'deleted')
      expect(result).toBe(true)
    })

    it('should return false if recording not found', async () => {
      const { getRecordingById } = await import('../../services/database')
      const id = '550e8400-e29b-41d4-a716-446655440000'
      vi.mocked(getRecordingById).mockReturnValue(undefined)

      const result = await handlers['recordings:delete'](null, id)

      expect(result).toBe(false)
    })

    it('should not update status if file deletion fails', async () => {
      const { getRecordingById, updateRecordingStatus } = await import('../../services/database')
      const { deleteRecording } = await import('../../services/file-storage')
      const id = '550e8400-e29b-41d4-a716-446655440000'
      vi.mocked(getRecordingById).mockReturnValue({
        id,
        file_path: '/path/to/file.wav',
        filename: 'file.wav'
      } as any)
      vi.mocked(deleteRecording).mockReturnValue(false)

      const result = await handlers['recordings:delete'](null, id)

      expect(updateRecordingStatus).not.toHaveBeenCalled()
      expect(result).toBe(false)
    })

    it('should return false for invalid ID format', async () => {
      const result = await handlers['recordings:delete'](null, 'not-a-uuid')

      expect(result).toBe(false)
    })

    it('should return false on error', async () => {
      const { getRecordingById } = await import('../../services/database')
      const id = '550e8400-e29b-41d4-a716-446655440000'
      vi.mocked(getRecordingById).mockImplementation(() => {
        throw new Error('DB error')
      })

      const result = await handlers['recordings:delete'](null, id)

      expect(result).toBe(false)
    })
  })

  describe('recordings:deleteBatch', () => {
    it('should delete multiple recordings and return results', async () => {
      const { getRecordingById } = await import('../../services/database')
      const { deleteRecording } = await import('../../services/file-storage')

      const id1 = '550e8400-e29b-41d4-a716-446655440000'
      const id2 = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'

      vi.mocked(getRecordingById)
        .mockReturnValueOnce({ id: id1, file_path: '/path/file1.wav', filename: 'file1.wav' } as any)
        .mockReturnValueOnce({ id: id2, file_path: '/path/file2.wav', filename: 'file2.wav' } as any)
      vi.mocked(deleteRecording).mockReturnValue(true)

      const result = await handlers['recordings:deleteBatch'](null, [id1, id2])

      expect(result.success).toBe(true)
      expect(result.deleted).toBe(2)
      expect(result.failed).toBe(0)
      expect(result.errors).toEqual([])
    })

    it('should return partial results when some deletions fail', async () => {
      const { getRecordingById } = await import('../../services/database')
      const { deleteRecording } = await import('../../services/file-storage')

      const id1 = '550e8400-e29b-41d4-a716-446655440000'
      const id2 = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'

      vi.mocked(getRecordingById)
        .mockReturnValueOnce({ id: id1, file_path: '/path/file1.wav', filename: 'file1.wav' } as any)
        .mockReturnValueOnce(undefined) // second recording not found

      vi.mocked(deleteRecording).mockReturnValue(true)

      const result = await handlers['recordings:deleteBatch'](null, [id1, id2])

      expect(result.success).toBe(false)
      expect(result.deleted).toBe(1)
      expect(result.failed).toBe(1)
      expect(result.errors).toHaveLength(1)
    })

    it('should reject invalid IDs', async () => {
      const result = await handlers['recordings:deleteBatch'](null, ['not-a-uuid'])

      expect(result.success).toBe(false)
      expect(result.deleted).toBe(0)
    })

    it('should reject empty array', async () => {
      const result = await handlers['recordings:deleteBatch'](null, [])

      expect(result.success).toBe(false)
    })

    it('should handle errors gracefully', async () => {
      const { getRecordingById } = await import('../../services/database')
      const id1 = '550e8400-e29b-41d4-a716-446655440000'

      vi.mocked(getRecordingById).mockImplementation(() => {
        throw new Error('DB error')
      })

      const result = await handlers['recordings:deleteBatch'](null, [id1])

      expect(result.success).toBe(false)
      expect(result.failed).toBe(1)
      expect(result.errors[0].error).toBe('DB error')
    })
  })

  describe('recordings:linkToMeeting', () => {
    it('should link a recording to a meeting with manual method', async () => {
      const { linkRecordingToMeeting } = await import('../../services/database')
      const recId = '550e8400-e29b-41d4-a716-446655440000'
      const meetId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'

      await handlers['recordings:linkToMeeting'](null, recId, meetId)

      expect(linkRecordingToMeeting).toHaveBeenCalledWith(recId, meetId, 1.0, 'manual')
    })

    it('should throw on validation error for invalid recording ID', async () => {
      await expect(
        handlers['recordings:linkToMeeting'](null, 'bad-id', '550e8400-e29b-41d4-a716-446655440000')
      ).rejects.toThrow()
    })

    it('should throw on validation error for invalid meeting ID', async () => {
      await expect(
        handlers['recordings:linkToMeeting'](null, '550e8400-e29b-41d4-a716-446655440000', 'bad-id')
      ).rejects.toThrow()
    })
  })

  describe('recordings:unlinkFromMeeting', () => {
    it('should unlink a recording from its meeting', async () => {
      const { linkRecordingToMeeting } = await import('../../services/database')
      const recId = '550e8400-e29b-41d4-a716-446655440000'

      await handlers['recordings:unlinkFromMeeting'](null, recId)

      expect(linkRecordingToMeeting).toHaveBeenCalledWith(recId, '', 0, '')
    })

    it('should throw on validation error for invalid recording ID', async () => {
      await expect(
        handlers['recordings:unlinkFromMeeting'](null, 'bad-id')
      ).rejects.toThrow()
    })
  })

  describe('recordings:getTranscript', () => {
    it('should return transcript for a valid recording ID', async () => {
      const { getTranscriptByRecordingId } = await import('../../services/database')
      const recId = '550e8400-e29b-41d4-a716-446655440000'
      const mockTranscript = { id: 't-1', recording_id: recId, full_text: 'Hello world' }
      vi.mocked(getTranscriptByRecordingId).mockReturnValue(mockTranscript as any)

      const result = await handlers['recordings:getTranscript'](null, recId)

      expect(getTranscriptByRecordingId).toHaveBeenCalledWith(recId)
      expect(result).toEqual(mockTranscript)
    })

    it('should return undefined for invalid recording ID', async () => {
      const result = await handlers['recordings:getTranscript'](null, 'invalid')

      expect(result).toBeUndefined()
    })
  })

  describe('recordings:transcribe', () => {
    // Realigned per spec §5.7: recordings:transcribe now routes through the queue
    // (addToQueue + processQueueManually) instead of calling transcribeManually directly.
    // transcribeManually is preserved as an export for e2e-smoke.test.ts only.
    it('should enqueue recording and call processQueueManually', async () => {
      const { addToQueue } = await import('../../services/database')
      const { processQueueManually } = await import('../../services/transcription')
      const recId = '550e8400-e29b-41d4-a716-446655440000'
      vi.mocked(addToQueue).mockReturnValue('queue-item-id')
      vi.mocked(processQueueManually).mockResolvedValue(undefined)

      const result = await handlers['recordings:transcribe'](null, recId)

      // spec §5.7: handler enqueues first, then triggers the queue processor
      expect(addToQueue).toHaveBeenCalledWith(recId)
      expect(processQueueManually).toHaveBeenCalled()
      // AC6: returns the queue-item id so the renderer's forced re-transcribe can
      // update the in-app queue panel (mirrors recordings:addToQueue).
      expect(result).toBe('queue-item-id')
    })

    it('should throw on validation error for invalid ID', async () => {
      await expect(
        handlers['recordings:transcribe'](null, 'bad-id')
      ).rejects.toThrow()
    })

    // D5-T4 §6.8 / AC6: re-transcribe on an ALREADY-transcribed recording must
    // clear BOTH stage markers (so the worker short-circuit is defeated and a
    // FRESH Stage 1 re-runs) AND drop prior speaker mappings — BEFORE enqueueing.
    it('clears markers + drops prior speaker mappings when the recording already has a transcript (re-transcribe)', async () => {
      const {
        getTranscriptByRecordingId,
        clearTranscriptForRetranscribe,
        deleteRecordingSpeakersForRecording,
        addToQueue
      } = await import('../../services/database')
      const { processQueueManually } = await import('../../services/transcription')
      const recId = '550e8400-e29b-41d4-a716-446655440000'
      // Existing transcript: both stage markers set (full_text + summarization_provider).
      vi.mocked(getTranscriptByRecordingId).mockReturnValue({
        id: 't-1',
        recording_id: recId,
        full_text: 'PRIOR TRANSCRIPT',
        summarization_provider: 'gemini'
      } as any)

      await handlers['recordings:transcribe'](null, recId)

      // Markers cleared (defeats the worker short-circuit) BEFORE enqueueing.
      expect(clearTranscriptForRetranscribe).toHaveBeenCalledWith(recId)
      // Prior label->contact mappings dropped (a new ASR pass re-letters speakers).
      expect(deleteRecordingSpeakersForRecording).toHaveBeenCalledWith(recId)
      // Then enqueued + processed as usual.
      expect(addToQueue).toHaveBeenCalledWith(recId)
      expect(processQueueManually).toHaveBeenCalled()
    })

    it('does NOT clear markers or drop mappings on a first-time transcribe (no transcript row)', async () => {
      const {
        getTranscriptByRecordingId,
        clearTranscriptForRetranscribe,
        deleteRecordingSpeakersForRecording,
        addToQueue
      } = await import('../../services/database')
      const { processQueueManually } = await import('../../services/transcription')
      const recId = '550e8400-e29b-41d4-a716-446655440000'
      vi.mocked(getTranscriptByRecordingId).mockReturnValue(undefined) // no transcript yet

      await handlers['recordings:transcribe'](null, recId)

      // First-time transcribe: nothing to clear or drop.
      expect(clearTranscriptForRetranscribe).not.toHaveBeenCalled()
      expect(deleteRecordingSpeakersForRecording).not.toHaveBeenCalled()
      // Still enqueues + processes normally.
      expect(addToQueue).toHaveBeenCalledWith(recId)
      expect(processQueueManually).toHaveBeenCalled()
    })

    it('should propagate errors from processQueueManually', async () => {
      // spec §5.7: the handler awaits processQueueManually — its errors propagate.
      const { processQueueManually } = await import('../../services/transcription')
      const recId = '550e8400-e29b-41d4-a716-446655440000'
      vi.mocked(processQueueManually).mockRejectedValue(new Error('Queue processing failed'))

      await expect(
        handlers['recordings:transcribe'](null, recId)
      ).rejects.toThrow('Queue processing failed')
    })
  })

  describe('recordings:getWatcherStatus', () => {
    it('should return watcher status', async () => {
      const { getWatcherStatus } = await import('../../services/recording-watcher')
      vi.mocked(getWatcherStatus).mockReturnValue({ isWatching: true, path: '/recordings' })

      const result = await handlers['recordings:getWatcherStatus'](null)

      expect(result).toEqual({ isWatching: true, path: '/recordings' })
    })
  })

  describe('recordings:startWatcher', () => {
    it('should call startRecordingWatcher', async () => {
      const { startRecordingWatcher } = await import('../../services/recording-watcher')

      await handlers['recordings:startWatcher'](null)

      expect(startRecordingWatcher).toHaveBeenCalled()
    })
  })

  describe('recordings:stopWatcher', () => {
    it('should call stopRecordingWatcher', async () => {
      const { stopRecordingWatcher } = await import('../../services/recording-watcher')

      await handlers['recordings:stopWatcher'](null)

      expect(stopRecordingWatcher).toHaveBeenCalled()
    })
  })

  describe('recordings:getTranscriptionStatus', () => {
    it('should return transcription processing status', async () => {
      const { getTranscriptionStatus } = await import('../../services/transcription')
      const mockStatus = { isProcessing: true, pendingCount: 3, processingCount: 1 }
      vi.mocked(getTranscriptionStatus).mockReturnValue(mockStatus)

      const result = await handlers['recordings:getTranscriptionStatus'](null)

      expect(result).toEqual(mockStatus)
    })
  })

  describe('recordings:startTranscriptionProcessor', () => {
    it('should call startTranscriptionProcessor', async () => {
      const { startTranscriptionProcessor } = await import('../../services/transcription')

      await handlers['recordings:startTranscriptionProcessor'](null)

      expect(startTranscriptionProcessor).toHaveBeenCalled()
    })
  })

  describe('recordings:stopTranscriptionProcessor', () => {
    it('should call stopTranscriptionProcessor', async () => {
      const { stopTranscriptionProcessor } = await import('../../services/transcription')

      await handlers['recordings:stopTranscriptionProcessor'](null)

      expect(stopTranscriptionProcessor).toHaveBeenCalled()
    })
  })

  describe('transcription:cancel', () => {
    it('should cancel transcription and return success', async () => {
      const { cancelTranscription } = await import('../../services/transcription')
      vi.mocked(cancelTranscription).mockReturnValue(undefined)

      const result = await handlers['transcription:cancel'](null, 'rec-1')

      expect(cancelTranscription).toHaveBeenCalledWith('rec-1')
      expect(result).toEqual({ success: true })
    })

    it('should return failure on error', async () => {
      const { cancelTranscription } = await import('../../services/transcription')
      vi.mocked(cancelTranscription).mockImplementation(() => {
        throw new Error('Cancel failed')
      })

      const result = await handlers['transcription:cancel'](null, 'rec-1')

      expect(result).toEqual({ success: false })
    })
  })

  describe('transcription:cancelAll', () => {
    it('should cancel all and return count', async () => {
      const { cancelAllTranscriptions } = await import('../../services/transcription')
      vi.mocked(cancelAllTranscriptions).mockReturnValue(5)

      const result = await handlers['transcription:cancelAll'](null)

      expect(result).toEqual({ success: true, count: 5 })
    })

    it('should return failure with zero count on error', async () => {
      const { cancelAllTranscriptions } = await import('../../services/transcription')
      vi.mocked(cancelAllTranscriptions).mockImplementation(() => {
        throw new Error('Cancel all failed')
      })

      const result = await handlers['transcription:cancelAll'](null)

      expect(result).toEqual({ success: false, count: 0 })
    })
  })

  describe('transcription:getQueue', () => {
    it('should return queue items', async () => {
      const { getQueueItems } = await import('../../services/database')
      const mockQueue = [
        { id: 'q1', recording_id: 'r1', status: 'pending' },
        { id: 'q2', recording_id: 'r2', status: 'processing' }
      ]
      vi.mocked(getQueueItems).mockReturnValue(mockQueue as any)

      const result = await handlers['transcription:getQueue'](null)

      expect(result).toEqual(mockQueue)
    })

    it('should return empty array on error', async () => {
      const { getQueueItems } = await import('../../services/database')
      vi.mocked(getQueueItems).mockImplementation(() => {
        throw new Error('DB error')
      })

      const result = await handlers['transcription:getQueue'](null)

      expect(result).toEqual([])
    })
  })

  describe('transcription:updateQueueItem', () => {
    it('should update queue item and return true', async () => {
      const { updateQueueItem } = await import('../../services/database')

      const result = await handlers['transcription:updateQueueItem'](null, 'q1', 'processing')

      expect(updateQueueItem).toHaveBeenCalledWith('q1', 'processing', undefined)
      expect(result).toBe(true)
    })

    it('should pass error message when provided', async () => {
      const { updateQueueItem } = await import('../../services/database')

      const result = await handlers['transcription:updateQueueItem'](null, 'q1', 'error', 'Something broke')

      expect(updateQueueItem).toHaveBeenCalledWith('q1', 'error', 'Something broke')
      expect(result).toBe(true)
    })

    it('should return false on error', async () => {
      const { updateQueueItem } = await import('../../services/database')
      vi.mocked(updateQueueItem).mockImplementation(() => {
        throw new Error('Update failed')
      })

      const result = await handlers['transcription:updateQueueItem'](null, 'q1', 'processing')

      expect(result).toBe(false)
    })
  })

  describe('recordings:scanFolder', () => {
    it('should return list of recording files', async () => {
      const { getRecordingFiles } = await import('../../services/file-storage')
      vi.mocked(getRecordingFiles).mockReturnValue(['file1.wav', 'file2.mp3'])

      const result = await handlers['recordings:scanFolder'](null)

      expect(result).toEqual(['file1.wav', 'file2.mp3'])
    })
  })

  describe('recordings:getCandidates', () => {
    it('should return meeting candidates for a valid recording ID', async () => {
      const { getCandidatesForRecordingWithDetails } = await import('../../services/database')
      const recId = '550e8400-e29b-41d4-a716-446655440000'
      const mockCandidates = [
        { recording_id: recId, meeting_id: 'm-1', confidence_score: 0.9 }
      ]
      vi.mocked(getCandidatesForRecordingWithDetails).mockReturnValue(mockCandidates as any)

      const result = await handlers['recordings:getCandidates'](null, recId)

      expect(getCandidatesForRecordingWithDetails).toHaveBeenCalledWith(recId)
      expect(result).toEqual({ success: true, data: mockCandidates })
    })

    it('should return error shape for invalid recording ID', async () => {
      const result = await handlers['recordings:getCandidates'](null, 'bad-id')

      expect(result).toEqual({ success: false, data: [], error: 'Invalid recording ID' })
    })
  })

  describe('recordings:getMeetingsNearDate', () => {
    it('should return meetings near a valid date string', async () => {
      const { getMeetingsNearDate } = await import('../../services/database')
      const mockMeetings = [{ id: 'm-1', subject: 'Standup' }]
      vi.mocked(getMeetingsNearDate).mockReturnValue(mockMeetings as any)

      const result = await handlers['recordings:getMeetingsNearDate'](null, '2025-06-15T10:00:00Z')

      expect(getMeetingsNearDate).toHaveBeenCalledWith('2025-06-15T10:00:00Z')
      expect(result).toEqual({ success: true, data: mockMeetings })
    })

    it('should return error shape for non-string date input', async () => {
      const result = await handlers['recordings:getMeetingsNearDate'](null, 12345)

      expect(result).toEqual({ success: false, data: [], error: 'Invalid date' })
    })

    it('should return error shape on error', async () => {
      const { getMeetingsNearDate } = await import('../../services/database')
      vi.mocked(getMeetingsNearDate).mockImplementation(() => {
        throw new Error('DB error')
      })

      const result = await handlers['recordings:getMeetingsNearDate'](null, '2025-06-15')

      expect(result).toEqual({ success: false, data: [], error: 'DB error' })
    })
  })

  describe('recordings:selectMeeting', () => {
    it('should link recording to meeting when meetingId is provided', async () => {
      const { linkRecordingToMeeting } = await import('../../services/database')

      const result = await handlers['recordings:selectMeeting'](null, 'rec-1', 'meet-1')

      expect(linkRecordingToMeeting).toHaveBeenCalledWith('rec-1', 'meet-1', 1.0, 'manual')
      expect(result).toEqual({ success: true })
    })

    it('should unlink recording when meetingId is null', async () => {
      const { linkRecordingToMeeting } = await import('../../services/database')

      const result = await handlers['recordings:selectMeeting'](null, 'rec-1', null)

      expect(linkRecordingToMeeting).toHaveBeenCalledWith('rec-1', '', 0, '')
      expect(result).toEqual({ success: true })
    })

    it('should return error on failure', async () => {
      const { linkRecordingToMeeting } = await import('../../services/database')
      vi.mocked(linkRecordingToMeeting).mockImplementation(() => {
        throw new Error('Link failed')
      })

      const result = await handlers['recordings:selectMeeting'](null, 'rec-1', 'meet-1')

      expect(result).toEqual({ success: false, error: 'Link failed' })
    })
  })

  describe('recordings:addToQueue', () => {
    it('should add recording to queue and update transcription status', async () => {
      const { addToQueue, updateRecordingTranscriptionStatus } = await import('../../services/database')
      vi.mocked(addToQueue).mockReturnValue('queue-item-id')

      const result = await handlers['recordings:addToQueue'](null, 'rec-1')

      expect(addToQueue).toHaveBeenCalledWith('rec-1')
      expect(updateRecordingTranscriptionStatus).toHaveBeenCalledWith('rec-1', 'queued')
      expect(result).toBe('queue-item-id')
    })

    it('should return false on error', async () => {
      const { addToQueue } = await import('../../services/database')
      vi.mocked(addToQueue).mockImplementation(() => {
        throw new Error('Queue full')
      })

      const result = await handlers['recordings:addToQueue'](null, 'rec-1')

      expect(result).toBe(false)
    })

    it('should reject when the selected ASR provider key is not configured', async () => {
      const { getConfig } = await import('../../services/config')
      vi.mocked(getConfig).mockReturnValue({
        transcription: {
          provider: 'gemini',
          geminiApiKey: '', // Empty API key
          geminiModel: 'gemini-3-pro-preview',
          openaiApiKey: '',
          whisperModel: 'whisper-1',
          autoTranscribe: true,
          language: 'es'
        }
      } as any)

      const result = await handlers['recordings:addToQueue'](null, 'rec-1')

      expect(result).toEqual({
        success: false,
        error: 'Transcription API key not configured. Please add your API key in Settings.'
      })
    })

    // Spec §5.6: addToQueue must reuse the same provider-aware preflight as
    // transcription:validateConfig — the gate is centralized in
    // validateTranscriptionConfig(). These two cases pin the P3 resurfacing
    // blocker: a Whisper+Ollama user must queue WITHOUT a Gemini key, and a
    // Whisper user with no OpenAI key must be rejected (Gemini-only gate would
    // have done the opposite and produced a silent false-success toast).
    it('should reject a whisper provider with no OpenAI key even when a Gemini key is present', async () => {
      const { getConfig } = await import('../../services/config')
      const { addToQueue: addToQueueDb } = await import('../../services/database')
      vi.mocked(getConfig).mockReturnValue({
        transcription: {
          provider: 'openai-whisper',
          geminiApiKey: 'gemini-present', // present but irrelevant for whisper ASR
          geminiModel: 'gemini-3-pro-preview',
          openaiApiKey: '', // missing — should reject
          whisperModel: 'whisper-1',
          autoTranscribe: true,
          language: 'es'
        }
      } as any)

      const result = await handlers['recordings:addToQueue'](null, 'rec-1')

      expect(result).toEqual({
        success: false,
        error: 'Transcription API key not configured. Please add your API key in Settings.'
      })
      expect(addToQueueDb).not.toHaveBeenCalled()
    })

    it('should queue a whisper+ollama user without requiring a Gemini key', async () => {
      const { getConfig } = await import('../../services/config')
      const { addToQueue: addToQueueDb, updateRecordingTranscriptionStatus } = await import('../../services/database')
      vi.mocked(addToQueueDb).mockReturnValue('queue-item-id')
      vi.mocked(getConfig).mockReturnValue({
        transcription: {
          provider: 'openai-whisper',
          geminiApiKey: '', // no Gemini key — must NOT block (P3 Ollama summarization)
          geminiModel: 'gemini-3-pro-preview',
          openaiApiKey: 'sk-present',
          whisperModel: 'whisper-1',
          autoTranscribe: true,
          language: 'es'
        },
        // P3 summarization provider with a valid key (structural read until config.summarization lands)
        summarization: { provider: 'ollama-cloud', ollamaCloudApiKey: 'ok-valid-key-12345', ollamaCloudModel: 'gpt-oss:120b' }
      } as any)

      const result = await handlers['recordings:addToQueue'](null, 'rec-1')

      expect(addToQueueDb).toHaveBeenCalledWith('rec-1')
      expect(updateRecordingTranscriptionStatus).toHaveBeenCalledWith('rec-1', 'queued')
      expect(result).toBe('queue-item-id')
    })

    // Speaker-diarization D1 §6.2/§8/AC9: provider 'assemblyai' with no key must
    // block queueing (loud, no silent fallback to gemini/whisper).
    it('should reject an assemblyai provider with no AssemblyAI key (AC9 loud fail)', async () => {
      const { getConfig } = await import('../../services/config')
      const { addToQueue: addToQueueDb } = await import('../../services/database')
      vi.mocked(getConfig).mockReturnValue({
        transcription: {
          provider: 'assemblyai',
          geminiApiKey: 'gemini-present', // present but irrelevant — must NOT be used as a fallback
          openaiApiKey: '',
          assemblyaiApiKey: '', // missing → must block
          assemblyaiModels: ['universal-3-pro', 'universal-2'],
          geminiModel: 'm',
          whisperModel: 'whisper-1',
          autoTranscribe: true,
          language: 'en'
        },
        summarization: { provider: 'ollama-cloud', ollamaCloudApiKey: 'ok', ollamaCloudModel: 'm' }
      } as never)

      const result = await handlers['recordings:addToQueue']({}, 'rec-1')

      expect(result).toEqual({
        success: false,
        error: 'Transcription API key not configured. Please add your API key in Settings.'
      })
      expect(addToQueueDb).not.toHaveBeenCalled()
    })

    it('should queue an assemblyai provider WITH a key', async () => {
      const { getConfig } = await import('../../services/config')
      const { addToQueue: addToQueueDb } = await import('../../services/database')
      vi.mocked(addToQueueDb).mockReturnValue('queue-item-id')
      vi.mocked(getConfig).mockReturnValue({
        transcription: {
          provider: 'assemblyai',
          geminiApiKey: '',
          openaiApiKey: '',
          assemblyaiApiKey: 'aai-key',
          assemblyaiModels: ['universal-3-pro', 'universal-2'],
          geminiModel: 'm',
          whisperModel: 'whisper-1',
          autoTranscribe: true,
          language: 'en'
        },
        summarization: { provider: 'ollama-cloud', ollamaCloudApiKey: 'ok', ollamaCloudModel: 'm' }
      } as never)

      const result = await handlers['recordings:addToQueue']({}, 'rec-2')
      expect(result).toBe('queue-item-id')
      expect(addToQueueDb).toHaveBeenCalledWith('rec-2')
    })
  })

  describe('recordings:processQueue', () => {
    it('should start the transcription processor and return true', async () => {
      const { startTranscriptionProcessor } = await import('../../services/transcription')

      const result = await handlers['recordings:processQueue'](null)

      expect(startTranscriptionProcessor).toHaveBeenCalled()
      expect(result).toBe(true)
    })

    it('should return false on error', async () => {
      const { startTranscriptionProcessor } = await import('../../services/transcription')
      vi.mocked(startTranscriptionProcessor).mockImplementation(() => {
        throw new Error('Processor error')
      })

      const result = await handlers['recordings:processQueue'](null)

      expect(result).toBe(false)
    })
  })

  describe('transcription:validateConfig', () => {
    it('should return not-ok with missing-key problem for openai-whisper with empty key', async () => {
      const { getConfig } = await import('../../services/config')
      vi.mocked(getConfig).mockReturnValue({
        transcription: {
          provider: 'openai-whisper',
          geminiApiKey: 'some-key',
          geminiModel: 'gemini-3-pro-preview',
          openaiApiKey: '',
          whisperModel: 'whisper-1',
          autoTranscribe: true,
          language: 'es'
        }
      } as any)

      const result = await handlers['transcription:validateConfig'](null)

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        { stage: 'asr', provider: 'openai-whisper', problem: 'missing-key' }
      ])
    })

    it('should return ok with empty problems for gemini defaults with key set', async () => {
      const { getConfig } = await import('../../services/config')
      vi.mocked(getConfig).mockReturnValue({
        transcription: {
          provider: 'gemini',
          geminiApiKey: 'test-gemini-key',
          geminiModel: 'gemini-3-pro-preview',
          openaiApiKey: '',
          whisperModel: 'whisper-1',
          autoTranscribe: true,
          language: 'es'
        }
      } as any)

      const result = await handlers['transcription:validateConfig'](null)

      expect(result.ok).toBe(true)
      expect(result.problems).toEqual([])
    })

    // Spec §5.6 / §5.2: P2 summarization is gemini-only. The realistic P2 scenario
    // is Whisper ASR (OpenAI key set) with an empty Gemini key — Stage 2 still runs
    // through Gemini, so the preflight MUST block on a summarization-stage problem.
    // Pins recording-handlers.ts:82-86 (the summarization push), the branch the P3
    // sweep edits when it wires Ollama summarization.
    it('should report a summarization gemini problem for whisper ASR (OpenAI key set) with no Gemini key', async () => {
      const { getConfig } = await import('../../services/config')
      vi.mocked(getConfig).mockReturnValue({
        transcription: {
          provider: 'openai-whisper',
          geminiApiKey: '', // empty — P2 summarization (gemini-only) cannot run
          geminiModel: 'gemini-3-pro-preview',
          openaiApiKey: 'sk-present', // ASR satisfied
          whisperModel: 'whisper-1',
          autoTranscribe: true,
          language: 'es'
        }
        // no summarization override → defaults to gemini
      } as any)

      const result = await handlers['transcription:validateConfig'](null)

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        { stage: 'summarization', provider: 'gemini', problem: 'missing-key' }
      ])
    })

    // Pins the dedup guard (recording-handlers.ts:83): gemini ASR with an empty
    // gemini key yields the asr-stage problem only — the summarization branch must
    // NOT push a second gemini problem.
    it('should emit exactly one gemini problem for gemini ASR with empty gemini key (dedup)', async () => {
      const { getConfig } = await import('../../services/config')
      vi.mocked(getConfig).mockReturnValue({
        transcription: {
          provider: 'gemini',
          geminiApiKey: '', // empty — fails ASR; summarization (also gemini) is deduped
          geminiModel: 'gemini-3-pro-preview',
          openaiApiKey: '',
          whisperModel: 'whisper-1',
          autoTranscribe: true,
          language: 'es'
        }
      } as any)

      const result = await handlers['transcription:validateConfig'](null)

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        { stage: 'asr', provider: 'gemini', problem: 'missing-key' }
      ])
      expect(result.problems.filter((p) => p.provider === 'gemini')).toHaveLength(1)
    })

    // Pins recording-handlers.ts: the new ollama-cloud branch emits a
    // summarization problem when the key is empty.
    it('should report a summarization ollama-cloud problem when ollama-cloud is selected with empty key', async () => {
      const { getConfig } = await import('../../services/config')
      vi.mocked(getConfig).mockReturnValue({
        transcription: {
          provider: 'openai-whisper',
          geminiApiKey: '',
          geminiModel: 'gemini-3-pro-preview',
          openaiApiKey: 'sk-present', // ASR satisfied
          whisperModel: 'whisper-1',
          autoTranscribe: true,
          language: 'es'
        },
        summarization: {
          provider: 'ollama-cloud',
          ollamaCloudApiKey: '', // missing
          ollamaCloudModel: 'gpt-oss:120b'
        }
      } as any)

      const result = await handlers['transcription:validateConfig'](null)

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        { stage: 'summarization', provider: 'ollama-cloud', problem: 'missing-key' }
      ])
    })

    // Ollama Cloud with a valid key → no summarization problem (ASR from Whisper
    // is satisfied, summarization key is present).
    it('should return ok for whisper ASR + ollama-cloud with key and model set', async () => {
      const { getConfig } = await import('../../services/config')
      vi.mocked(getConfig).mockReturnValue({
        transcription: {
          provider: 'openai-whisper',
          geminiApiKey: '',
          geminiModel: 'gemini-3-pro-preview',
          openaiApiKey: 'sk-present',
          whisperModel: 'whisper-1',
          autoTranscribe: true,
          language: 'es'
        },
        summarization: {
          provider: 'ollama-cloud',
          ollamaCloudApiKey: 'ok-valid-key-12345',
          ollamaCloudModel: 'gpt-oss:120b'
        }
      } as any)

      const result = await handlers['transcription:validateConfig'](null)

      expect(result.ok).toBe(true)
      expect(result.problems).toEqual([])
    })
  })

  describe('transcription:resummarize', () => {
    // spec §5.3/§5.6: clears the stage marker (keeping the old summary) and
    // enqueues — the worker's resume rule runs Stage 2 only.
    it('clears the stage marker, enqueues, and triggers the queue processor', async () => {
      const { clearTranscriptStage2Marker, addToQueue } = await import('../../services/database')
      const { processQueueManually } = await import('../../services/transcription')
      const recId = '550e8400-e29b-41d4-a716-446655440000'

      const result = await handlers['transcription:resummarize'](null, recId)

      expect(clearTranscriptStage2Marker).toHaveBeenCalledWith(recId)
      expect(addToQueue).toHaveBeenCalledWith(recId)
      expect(processQueueManually).toHaveBeenCalled()
      expect(result).toEqual({ success: true })
    })

    it('returns an error shape (not a throw) for an invalid recording ID', async () => {
      const { clearTranscriptStage2Marker, addToQueue } = await import('../../services/database')

      const result = await handlers['transcription:resummarize'](null, 'bad-id')

      expect(result.success).toBe(false)
      expect(result.error).toBeTruthy()
      expect(clearTranscriptStage2Marker).not.toHaveBeenCalled()
      expect(addToQueue).not.toHaveBeenCalled()
    })

    it('surfaces a clear-marker failure as an error result', async () => {
      const { clearTranscriptStage2Marker, addToQueue } = await import('../../services/database')
      const recId = '550e8400-e29b-41d4-a716-446655440000'
      vi.mocked(clearTranscriptStage2Marker).mockImplementation(() => {
        throw new Error('no transcript row for recording')
      })

      const result = await handlers['transcription:resummarize'](null, recId)

      expect(result).toEqual({ success: false, error: 'no transcript row for recording' })
      expect(addToQueue).not.toHaveBeenCalled()
    })
  })

  describe('transcription:retryAll (auto-pipeline P4 Task 4)', () => {
    it('calls rependFailedItems with all three provider markers and triggers processQueueManually', async () => {
      const { rependFailedItems } = await import('../../services/database')
      const { processQueueManually } = await import('../../services/transcription')
      vi.mocked(rependFailedItems).mockReturnValue(3)

      const result = await handlers['transcription:retryAll'](null)

      expect(rependFailedItems).toHaveBeenCalledWith(['OpenAI', 'Ollama Cloud', 'Gemini API key', 'AssemblyAI'])
      expect(processQueueManually).toHaveBeenCalled()
      expect(result).toEqual({ success: true, count: 3 })
    })

    it('returns count=0 and success=true when no failed items match', async () => {
      const { rependFailedItems } = await import('../../services/database')
      vi.mocked(rependFailedItems).mockReturnValue(0)

      const result = await handlers['transcription:retryAll'](null)

      expect(result).toEqual({ success: true, count: 0 })
    })

    it('returns failure shape on error', async () => {
      const { rependFailedItems } = await import('../../services/database')
      vi.mocked(rependFailedItems).mockImplementation(() => {
        throw new Error('DB locked')
      })

      const result = await handlers['transcription:retryAll'](null)

      expect(result).toEqual({ success: false, count: 0 })
    })
  })
})
