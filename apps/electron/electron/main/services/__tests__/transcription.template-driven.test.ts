/**
 * End-to-end: a recording whose transcript excerpt contains a template's trigger
 * ('sermon') is auto-selected via the content-aware prefilter (Task 2), Stage-2
 * applies the template (Task 1 reframed prompt), and the written summary reflects
 * the template's multi-section structure while the other fields stay valid arrays.
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'
import os from 'os'
import { makeFakeLlm } from './fixtures/llm'
import { sermonTemplate, salesTemplate } from './fixtures/templates'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), getName: vi.fn(() => 'test') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  Notification: { isSupported: vi.fn(() => false) },
}))

vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    storage: { dataPath: os.tmpdir(), maxRecordingsGB: 50 },
    transcription: {
      provider: 'gemini',
      geminiApiKey: 'k',
      geminiModel: 'gemini-x',
      autoTranscribe: false,
      diarization: {},
    },
    summarization: { provider: 'gemini' },
  })),
  updateConfig: vi.fn(async () => {}),
  getDataPath: vi.fn(() => os.tmpdir()),
}))

vi.mock('../vector-store', () => ({ getVectorStore: vi.fn(() => null) }))

// REAL selector — NOT mocked — so prefilter+buildExcerpt run on the sermon excerpt.

const fakeLlm = makeFakeLlm()
vi.mock('../llm/llm-provider', () => ({ getLlmProvider: vi.fn(() => fakeLlm) }))
vi.mock('../asr/asr-provider', () => ({ getAsrProvider: vi.fn(() => ({ transcribe: vi.fn() })) }))
vi.mock('../summarization-templates', () => ({
  userTemplates: vi.fn(() => [sermonTemplate, salesTemplate]),
  getTemplateById: vi.fn((id: string) =>
    [sermonTemplate, salesTemplate].find((t) => t.id === id) ?? null
  ),
}))

// Capture what Stage-2 writes so we can assert the template-shaped summary.
const updateTranscriptStage2 = vi.fn()

vi.mock('../database', () => ({
  // The recording filename is generic — only the content excerpt triggers the match.
  getRecordingById: vi.fn(() => ({
    id: '1',
    filename: 'external-2026-06-22-19-00-18.m4a',
    file_path: null,
  })),
  // Stage-2-only resume: full_text present with the trigger word; marker NULL.
  getTranscriptByRecordingId: vi.fn(() => ({
    full_text: 'Welcome to todays sermon on the book of Romans. God works for good.',
    summarization_provider: null,
    summarization_template_id: null,
    title_suggestion: null,
  })),
  updateRecordingTranscriptionStatus: vi.fn(),
  // Two candidate meetings so the meeting-selection code path is exercised
  // (validateAnalysis requires selected_meeting_id/meeting_confidence when hasCandidates).
  findCandidateMeetingsForRecording: vi.fn(() => [
    { id: 'm1', subject: 'Service' },
    { id: 'm2', subject: 'Worship' },
  ]),
  // No prior cache run → real prefilter runs.
  getLatestTemplateRun: vi.fn(() => null),
  // buildAttributedTranscript MUST return null so analysisInput falls back to fullText
  // (the sermon excerpt) — a real attributed transcript would undermine the content path.
  buildAttributedTranscript: vi.fn(() => null),
  upsertTranscriptStage1: vi.fn(),
  updateTranscriptStage2,
  // Remaining imported accessors — no-ops are sufficient.
  getQueueItems: vi.fn(() => []),
  getRunnableQueueItems: vi.fn(() => []),
  parkQueueItem: vi.fn(),
  clearParking: vi.fn(),
  getQueueItemParkedHours: vi.fn(() => null),
  updateQueueItem: vi.fn(),
  updateQueueProgress: vi.fn(),
  getMeetingById: vi.fn(() => null),
  addRecordingMeetingCandidate: vi.fn(),
  linkRecordingToMeeting: vi.fn(),
  updateKnowledgeCaptureTitle: vi.fn(),
  removeFromQueueByRecordingId: vi.fn(),
  cancelPendingTranscriptions: vi.fn(() => 0),
  acquireTranscriptionLock: vi.fn(() => true),
  releaseTranscriptionLock: vi.fn(() => true),
  clearStaleTranscriptionLock: vi.fn(),
  resetStuckTranscriptions: vi.fn(() => ({ recordingsReset: 0, queueItemsReset: 0 })),
  deleteRecordingSpeakersForRecording: vi.fn(),
  deleteLabelEmbeddingsForRecording: vi.fn(),
  deleteWindowEmbeddingsForRecording: vi.fn(),
  expireSuggestionsForRecording: vi.fn(),
  insertDiarizationRun: vi.fn(),
  recordTemplateRun: vi.fn(),
  run: vi.fn(),
  queryOne: vi.fn(() => null),
}))

describe('end-to-end: content-routed template drives a structured summary', () => {
  it(
    'trigger in excerpt auto-selects sermon template; Stage-2 writes multi-section summary ' +
      'and valid arrays',
    async () => {
      const { transcribeManually } = await import('../transcription')
      await transcribeManually('1')

      // The ValidatedAnalysis the worker persisted (2nd arg: updateTranscriptStage2(id, analysis)).
      expect(updateTranscriptStage2).toHaveBeenCalled()
      const written = updateTranscriptStage2.mock.calls[0][1]

      // Summary must reflect the sermon template's multi-section structure.
      expect(written.summary).toContain('## Scripture')
      expect(written.summary).toContain('\n') // multi-line / structured
      expect(written.summary).not.toBe('Generic two sentence summary. Another sentence.')

      // The worker JSON-stringifies non-empty arrays before passing them to
      // updateTranscriptStage2 (transcription.ts line 808-810). So written.action_items
      // et al. are JSON strings that parse to non-empty arrays — "valid non-empty arrays"
      // in the storage sense.
      const actionItems = JSON.parse(written.action_items) as unknown[]
      expect(Array.isArray(actionItems)).toBe(true)
      expect(actionItems.length).toBeGreaterThan(0)

      const topics = JSON.parse(written.topics) as unknown[]
      expect(Array.isArray(topics)).toBe(true)
      expect(topics.length).toBeGreaterThan(0)

      const keyPoints = JSON.parse(written.key_points) as unknown[]
      expect(Array.isArray(keyPoints)).toBe(true)
      expect(keyPoints.length).toBeGreaterThan(0)
    }
  )
})
