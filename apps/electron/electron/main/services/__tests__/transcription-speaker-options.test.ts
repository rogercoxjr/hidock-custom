/**
 * Voice Library Phase 2C: speaker_options + diarization-run instrumentation
 * integration tests for the transcription service Stage-1 path.
 *
 * All external boundaries (database, ASR factory, LLM, vector store, activity log)
 * are mocked so we assert only the wiring between computeSpeakerOptions,
 * asr.transcribe(), insertDiarizationRun, and upsertTranscriptStage1.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockUpsertTranscriptStage1 = vi.fn()
const mockUpdateTranscriptStage2 = vi.fn()
const mockInsertDiarizationRun = vi.fn()
const mockGetRecordingById = vi.fn()
const mockGetTranscriptByRecordingId = vi.fn()
const mockUpdateRecordingTranscriptionStatus = vi.fn()
const mockFindCandidateMeetings = vi.fn()
const mockBuildAttributedTranscript = vi.fn()

const mockAsrTranscribe = vi.fn()
const mockLlmGenerate = vi.fn()

// ---------------------------------------------------------------------------
// Mocks (must be declared before importing transcription.ts)
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() }
}))

vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    transcription: {
      provider: 'assemblyai',
      assemblyaiApiKey: 'test-key',
      assemblyaiModels: ['universal-3-pro', 'universal-2'],
      autoTranscribe: false,
      language: 'en',
      whisperModel: '',
      geminiModel: '',
      diarization: {
        speakerOptionsEnabled: true,
        minSpeakers: 2,
        maxSpeakers: 8,
        minDurationMsForHint: 120000,
        policyVersion: 1
      }
    },
    summarization: {
      provider: 'ollama-cloud',
      ollamaCloudApiKey: '',
      ollamaCloudModel: 'test-llm'
    }
  }))
}))

vi.mock('../database', () => ({
  getRecordingById: (...args: any[]) => mockGetRecordingById(...args),
  getTranscriptByRecordingId: (...args: any[]) => mockGetTranscriptByRecordingId(...args),
  upsertTranscriptStage1: (...args: any[]) => mockUpsertTranscriptStage1(...args),
  updateTranscriptStage2: (...args: any[]) => mockUpdateTranscriptStage2(...args),
  updateRecordingTranscriptionStatus: (...args: any[]) => mockUpdateRecordingTranscriptionStatus(...args),
  insertDiarizationRun: (...args: any[]) => mockInsertDiarizationRun(...args),
  findCandidateMeetingsForRecording: (...args: any[]) => mockFindCandidateMeetings(...args),
  buildAttributedTranscript: (...args: any[]) => mockBuildAttributedTranscript(...args),
  // Unused by transcribeManually but imported by the module
  getQueueItems: vi.fn(() => []),
  getRunnableQueueItems: vi.fn(() => []),
  parkQueueItem: vi.fn(),
  clearParking: vi.fn(),
  getQueueItemParkedHours: vi.fn(() => null),
  updateQueueItem: vi.fn(),
  updateQueueProgress: vi.fn(),
  getMeetingById: vi.fn(),
  addRecordingMeetingCandidate: vi.fn(),
  linkRecordingToMeeting: vi.fn(),
  updateKnowledgeCaptureTitle: vi.fn(),
  removeFromQueueByRecordingId: vi.fn(),
  cancelPendingTranscriptions: vi.fn(() => 0),
  acquireTranscriptionLock: vi.fn().mockReturnValue(true),
  releaseTranscriptionLock: vi.fn(),
  clearStaleTranscriptionLock: vi.fn(),
  resetStuckTranscriptions: vi.fn(),
  deleteRecordingSpeakersForRecording: vi.fn(),
  deleteLabelEmbeddingsForRecording: vi.fn(),
  deleteWindowEmbeddingsForRecording: vi.fn(),
  expireSuggestionsForRecording: vi.fn(),
  run: vi.fn(),
  queryOne: vi.fn()
}))

vi.mock('../asr/asr-provider', () => ({
  getAsrProvider: vi.fn(() => ({
    transcribe: (...args: any[]) => mockAsrTranscribe(...args)
  }))
}))

vi.mock('../llm/llm-provider', () => ({
  getLlmProvider: vi.fn(() => ({
    generate: (...args: any[]) => mockLlmGenerate(...args)
  }))
}))

vi.mock('../vector-store', () => ({
  getVectorStore: vi.fn(() => ({
    indexTranscript: vi.fn(() => 0)
  }))
}))

vi.mock('../activity-log', () => ({
  emitActivityLog: vi.fn()
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => true)
  }
})

describe('transcription speaker_options / diarization instrumentation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetTranscriptByRecordingId.mockReturnValue(undefined)
    mockFindCandidateMeetings.mockReturnValue([])
    mockBuildAttributedTranscript.mockReturnValue(null)
    mockInsertDiarizationRun.mockReturnValue('diar_run_123')
    mockLlmGenerate.mockResolvedValue(JSON.stringify({
      summary: 'summary',
      action_items: [],
      topics: [],
      key_points: [],
      title_suggestion: 'Title',
      question_suggestions: [],
      language: 'en'
    }))
  })

  const baseRecording = {
    id: 'rec-1',
    filename: 'meeting.wav',
    file_path: '/recordings/meeting.wav',
    created_at: new Date().toISOString()
  }

  it('sends speaker_options for recordings >= 2 minutes and records the run', async () => {
    mockGetRecordingById.mockReturnValue({
      ...baseRecording,
      duration_seconds: 180
    })

    mockAsrTranscribe.mockResolvedValue({
      text: 'hello world',
      language: 'en',
      turns: [
        { speaker: 'A', startMs: 0, endMs: 5000, text: 'hello' },
        { speaker: 'B', startMs: 5000, endMs: 9000, text: 'world' }
      ]
    })

    const { transcribeManually } = await import('../transcription')
    await transcribeManually('rec-1')

    expect(mockAsrTranscribe).toHaveBeenCalledWith(
      '/recordings/meeting.wav',
      expect.objectContaining({
        speakerOptions: { min_speakers_expected: 2, max_speakers_expected: 8 }
      })
    )

    expect(mockInsertDiarizationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^diar_/),
        recording_id: 'rec-1',
        transcript_id: 'trans_rec-1',
        provider: 'assemblyai',
        model: 'universal-3-pro,universal-2',
        options_min: 2,
        options_max: 8,
        label_count: 2,
        is_solo: 0,
        policy_version: 1,
        duration_ms: 180000,
        created_at: expect.any(String)
      })
    )

    expect(mockUpsertTranscriptStage1).toHaveBeenCalledWith(
      expect.objectContaining({
        recording_id: 'rec-1',
        diarization_run_id: expect.stringMatching(/^diar_/),
        turns: expect.arrayContaining([
          expect.objectContaining({ speaker: 'A' }),
          expect.objectContaining({ speaker: 'B' })
        ])
      })
    )
  })

  it('omits speaker_options for short recordings and still instruments diarization when turns are returned', async () => {
    mockGetRecordingById.mockReturnValue({
      ...baseRecording,
      duration_seconds: 30
    })

    mockAsrTranscribe.mockResolvedValue({
      text: 'hi',
      turns: [{ speaker: 'A', startMs: 0, endMs: 1000, text: 'hi' }]
    })

    const { transcribeManually } = await import('../transcription')
    await transcribeManually('rec-1')

    expect(mockAsrTranscribe).toHaveBeenCalledWith(
      '/recordings/meeting.wav',
      expect.objectContaining({
        speakerOptions: undefined
      })
    )

    expect(mockInsertDiarizationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^diar_/),
        recording_id: 'rec-1',
        transcript_id: 'trans_rec-1',
        options_min: undefined,
        options_max: undefined,
        label_count: 1,
        is_solo: 1,
        solo_reason: 'single_label'
      })
    )
  })

  it('does not instrument a run when the ASR returns no turns (Whisper/Gemini path)', async () => {
    mockGetRecordingById.mockReturnValue({
      ...baseRecording,
      duration_seconds: 300
    })

    mockAsrTranscribe.mockResolvedValue({ text: 'flat transcript' })

    const { transcribeManually } = await import('../transcription')
    await transcribeManually('rec-1')

    expect(mockInsertDiarizationRun).not.toHaveBeenCalled()
    expect(mockUpsertTranscriptStage1).toHaveBeenCalledWith(
      expect.objectContaining({
        recording_id: 'rec-1',
        diarization_run_id: undefined
      })
    )
  })

  it('records duration_ms as null when the recording duration is unknown', async () => {
    mockGetRecordingById.mockReturnValue(baseRecording)

    mockAsrTranscribe.mockResolvedValue({
      text: 'hello world',
      turns: [
        { speaker: 'A', startMs: 0, endMs: 5000, text: 'hello' },
        { speaker: 'B', startMs: 5000, endMs: 9000, text: 'world' }
      ]
    })

    const { transcribeManually } = await import('../transcription')
    await transcribeManually('rec-1')

    expect(mockAsrTranscribe).toHaveBeenCalledWith(
      '/recordings/meeting.wav',
      expect.objectContaining({ speakerOptions: undefined })
    )

    expect(mockInsertDiarizationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        // Unknown duration becomes a SQL NULL in the database; the helper
        // converts an undefined property to NULL on insert.
        duration_ms: undefined,
        options_min: undefined,
        options_max: undefined,
        label_count: 2,
        is_solo: 0
      })
    )
  })

  it('produces distinct diarization_run_ids across multiple runs', async () => {
    mockGetRecordingById.mockReturnValue({
      ...baseRecording,
      duration_seconds: 180
    })

    mockAsrTranscribe.mockResolvedValue({
      text: 'hello world',
      turns: [
        { speaker: 'A', startMs: 0, endMs: 5000, text: 'hello' },
        { speaker: 'B', startMs: 5000, endMs: 9000, text: 'world' }
      ]
    })

    const { transcribeManually } = await import('../transcription')
    await transcribeManually('rec-1')
    await transcribeManually('rec-1')

    const calls = mockInsertDiarizationRun.mock.calls
    expect(calls).toHaveLength(2)
    const ids = calls.map((c) => (c[0] as { id: string }).id)
    expect(ids[0]).not.toBe(ids[1])
    expect(ids[0]).toMatch(/^diar_/)
    expect(ids[1]).toMatch(/^diar_/)
  })

  it('clears diarization_run_id on a non-diarizing re-transcribe', async () => {
    mockGetRecordingById.mockReturnValue({
      ...baseRecording,
      duration_seconds: 180
    })

    mockAsrTranscribe
      .mockResolvedValueOnce({
        text: 'hello world',
        turns: [
          { speaker: 'A', startMs: 0, endMs: 5000, text: 'hello' },
          { speaker: 'B', startMs: 5000, endMs: 9000, text: 'world' }
        ]
      })
      .mockResolvedValueOnce({ text: 'flat transcript' })

    const { transcribeManually } = await import('../transcription')
    await transcribeManually('rec-1')
    await transcribeManually('rec-1')

    expect(mockInsertDiarizationRun).toHaveBeenCalledTimes(1)
    const secondStage1 = mockUpsertTranscriptStage1.mock.calls[1][0]
    expect(secondStage1).toMatchObject({
      recording_id: 'rec-1',
      diarization_run_id: undefined
    })
  })
})
