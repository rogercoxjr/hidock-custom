/**
 * Transcription Service Tests
 *
 * BUG-TX-001: recordings.status stays 'transcribing' forever after transcription failure
 *   OBSERVED: User sees "Transcription in progress..." badge on recordings that failed
 *   ROOT CAUSE: processQueue() catch block updates queue item to 'failed' but did NOT
 *   update recordings.status back from 'transcribing' to 'failed'
 *   FIX: Added updateRecordingStatus(recordingId, 'failed') in the catch block
 *
 * @vitest-environment node
 */

// This test runs in node environment, so we must define mocks BEFORE imports
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Track calls to updateRecordingStatus
const mockUpdateRecordingStatus = vi.fn()
const mockUpdateQueueItem = vi.fn()
const mockGetQueueItems = vi.fn()
const mockGetRecordingById = vi.fn()

// Mock database
vi.mock('../database', () => ({
  getRecordingById: (...args: any[]) => mockGetRecordingById(...args),
  updateRecordingStatus: (...args: any[]) => mockUpdateRecordingStatus(...args),
  updateRecordingTranscriptionStatus: (...args: any[]) => mockUpdateRecordingStatus(...args),
  // Auto-pipeline P1 (spec §5.3): the two-stage worker now imports the stage-write
  // helpers. They are no-ops here — this test drives the *failure* path (Gemini
  // generateContent rejects at the Stage-1 ASR call), asserting only that the
  // queue item is marked failed and the recording status set to 'error'.
  getTranscriptByRecordingId: vi.fn(() => undefined),
  upsertTranscriptStage1: vi.fn(),
  updateTranscriptStage2: vi.fn(),
  getQueueItems: (...args: any[]) => mockGetQueueItems(...args),
  // Auto-pipeline P4 (spec §7.2): the worker now selects pending items via the
  // runnable filter (parked items excluded). The mock routes it to the same
  // queue stub so this failure-path test still drives its single pending item.
  getRunnableQueueItems: (...args: any[]) => mockGetQueueItems(...args),
  parkQueueItem: vi.fn(),
  clearParking: vi.fn(),
  getQueueItemParkedHours: vi.fn(() => null),
  updateQueueItem: (...args: any[]) => mockUpdateQueueItem(...args),
  updateQueueProgress: vi.fn(),
  getMeetingById: vi.fn(),
  findCandidateMeetingsForRecording: vi.fn(() => []),
  addRecordingMeetingCandidate: vi.fn(),
  linkRecordingToMeeting: vi.fn(),
  updateKnowledgeCaptureTitle: vi.fn(),
  removeFromQueueByRecordingId: vi.fn(),
  cancelPendingTranscriptions: vi.fn(() => 0),
  acquireTranscriptionLock: vi.fn().mockReturnValue(true),
  releaseTranscriptionLock: vi.fn().mockReturnValue(true),
  deleteRecordingSpeakersForRecording: vi.fn(),
  deleteLabelEmbeddingsForRecording: vi.fn(),
  expireSuggestionsForRecording: vi.fn(),
  clearStaleTranscriptionLock: vi.fn(), // Called on startTranscriptionProcessor()
  resetStuckTranscriptions: vi.fn().mockReturnValue({ recordingsReset: 0, queueItemsReset: 0 }), // Called on startTranscriptionProcessor()
  run: vi.fn(),
  queryOne: vi.fn()
}))

// Mock electron
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  },
  ipcMain: { handle: vi.fn() }
}))

// Mock config
vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    transcription: {
      // provider drives the Stage-1 ASR factory (auto-pipeline P1, spec §5.3).
      provider: 'gemini',
      geminiApiKey: 'test-api-key',
      geminiModel: 'gemini-2.0-flash'
    },
    // Auto-pipeline P3 (spec §5.4): drives the Stage-2 LLM factory.
    summarization: {
      provider: 'gemini',
      ollamaCloudApiKey: '',
      ollamaCloudModel: ''
    }
  }))
}))

// Mock google generative AI - make it fail.
// Newable-class idiom (matches e2e-smoke / providers-p1): the auto-pipeline P1
// provider modules call `new GoogleGenerativeAI(...)`, so the export must be a
// real class. generateContent rejects to exercise the Stage-1 ASR failure path.
vi.mock('@google/generative-ai', () => {
  const generateContent = vi.fn().mockRejectedValue(new Error('API rate limit exceeded'))
  class GoogleGenerativeAI {
    getGenerativeModel() {
      return { generateContent }
    }
  }
  return { GoogleGenerativeAI }
})

// Mock fs - simple approach that works in jsdom environment
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFile: vi.fn((_path: string, cb: (err: null, data: Buffer) => void) => {
      cb(null, Buffer.from('fake audio data'))
    })
  }
})

// Mock vector store
vi.mock('../vector-store', () => ({
  getVectorStore: vi.fn(() => null)
}))

describe('Transcription Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('BUG-TX-001: recordings.status stuck at transcribing after failure', () => {
    it('should update recordings.status to failed when transcription fails', async () => {
      const mockQueueItem = {
        id: 'queue-1',
        recording_id: 'rec-123',
        filename: 'test.wav',
        status: 'pending',
        attempts: 0
      }
      mockGetQueueItems.mockReturnValue([mockQueueItem])
      mockGetRecordingById.mockReturnValue({
        id: 'rec-123',
        filename: 'test.wav',
        file_path: '/recordings/test.wav',
        status: 'complete'
      })

      const { startTranscriptionProcessor, stopTranscriptionProcessor } = await import('../transcription')

      startTranscriptionProcessor()
      await new Promise(resolve => setTimeout(resolve, 500))
      stopTranscriptionProcessor()

      // The key assertion: when transcription fails, the recording status
      // must be updated to indicate failure so the UI stops showing "In Progress"
      const statusCalls = mockUpdateRecordingStatus.mock.calls

      // After the fix, we expect:
      // 1. updateRecordingTranscriptionStatus(rec-123, 'processing') - before attempt
      // 2. updateRecordingTranscriptionStatus(rec-123, 'error') - after failure
      // Even if the exact flow varies due to mocking, the FAILURE status call must exist
      const hasFailureCall = statusCalls.some(
        (call: any[]) => call[0] === 'rec-123' && call[1] === 'error'
      )

      // Also verify the queue item was marked as failed
      const queueUpdateCalls = mockUpdateQueueItem.mock.calls
      const hasQueueFailure = queueUpdateCalls.some(
        (call: any[]) => call[0] === 'queue-1' && call[1] === 'failed'
      )

      expect(hasQueueFailure).toBe(true)
      expect(hasFailureCall).toBe(true)
    })
  })
})
