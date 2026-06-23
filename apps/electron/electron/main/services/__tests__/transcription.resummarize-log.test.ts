// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'

// Must mock side-effectful modules BEFORE importing transcription.ts
vi.mock('../database', () => ({
  getRecordingById: vi.fn(),
  getTranscriptByRecordingId: vi.fn(() => undefined),
  upsertTranscriptStage1: vi.fn(),
  updateTranscriptStage2: vi.fn(),
  updateRecordingTranscriptionStatus: vi.fn(),
  getQueueItems: vi.fn(() => []),
  getRunnableQueueItems: vi.fn(() => []),
  parkQueueItem: vi.fn(),
  clearParking: vi.fn(),
  getQueueItemParkedHours: vi.fn(() => null),
  updateQueueItem: vi.fn(),
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
  clearStaleTranscriptionLock: vi.fn(),
  resetStuckTranscriptions: vi.fn().mockReturnValue({ recordingsReset: 0, queueItemsReset: 0 }),
  deleteRecordingSpeakersForRecording: vi.fn(),
  deleteLabelEmbeddingsForRecording: vi.fn(),
  deleteWindowEmbeddingsForRecording: vi.fn(),
  expireSuggestionsForRecording: vi.fn(),
  run: vi.fn(),
  queryOne: vi.fn(),
  buildAttributedTranscript: vi.fn(),
  insertDiarizationRun: vi.fn(),
  recordTemplateRun: vi.fn(),
  getLatestTemplateRun: vi.fn(() => null)
}))
vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    transcription: { provider: 'gemini', geminiApiKey: 'test', geminiModel: 'gemini-2.0-flash' },
    summarization: { provider: 'gemini', ollamaCloudApiKey: '', ollamaCloudModel: '' }
  }))
}))
vi.mock('../summarization-templates', () => ({
  userTemplates: vi.fn(() => []),
  getTemplateById: vi.fn(() => null),
  BUILTIN_DEFAULT_ID: 'builtin-default'
}))
vi.mock('../summarization-selector', () => ({
  selectTemplateForTranscript: vi.fn(async () => ({ kind: 'use_default', confidence: 0, reason: 'mock', elapsedMs: 0 })),
  prefilter: vi.fn(() => null),
  hashText: vi.fn((t: string) => `hash-${t.length}`),
  buildExcerpt: vi.fn(() => '')
}))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() }
}))

import { getQueuePickupLabel } from '../transcription'

describe('getQueuePickupLabel — truthful Stage-2-only label', () => {
  it('Stage-2-only resume → "Re-summarizing:"', () => {
    expect(getQueuePickupLabel('sermon.m4a', true)).toBe('Re-summarizing: sermon.m4a')
  })
  it('Stage-1 (fresh / re-transcribe) → "Transcribing:"', () => {
    expect(getQueuePickupLabel('sermon.m4a', false)).toBe('Transcribing: sermon.m4a')
  })
})
