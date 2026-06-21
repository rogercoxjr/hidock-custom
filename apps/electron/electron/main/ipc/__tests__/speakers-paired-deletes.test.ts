import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: class {},
}))

const dbMocks = {
  upsertRecordingSpeaker: vi.fn(), deleteRecordingSpeaker: vi.fn(),
  getRecordingSpeaker: vi.fn(() => undefined), getRecordingSpeakers: vi.fn(() => []),
  getContactById: vi.fn(() => ({ id: 'c', name: 'C' })),
  getTranscriptByRecordingId: vi.fn(() => ({ id: 't', turns: JSON.stringify([{ speaker: 'A', startMs: 0, endMs: 1000, text: 'x' }, { speaker: 'B', startMs: 1000, endMs: 2000, text: 'y' }]) })),
  updateTranscriptTurns: vi.fn(), deleteVoiceprintsBySource: vi.fn(),
  getPendingSuggestions: vi.fn(() => []), getSelfContactId: vi.fn(() => null),
  deleteLabelEmbeddingsForRecording: vi.fn(), deleteWindowEmbeddingsForRecording: vi.fn(),
  expireSuggestionsForRecording: vi.fn(), acceptSuggestion: vi.fn(), dismissSuggestion: vi.fn(),
}
vi.mock('../../services/database', () => dbMocks)
vi.mock('../../services/voiceprint-service', () => ({ embedRecordingLabels: vi.fn(), captureVoiceprint: vi.fn() }))
vi.mock('../../services/voiceprint/speaker-matcher', () => ({ runMatcher: vi.fn(async () => ({ diarizationRunId: null })) }))

describe('paired window-embedding deletes', () => {
  beforeEach(async () => {
    handlers.clear()
    Object.values(dbMocks).forEach((m) => m.mockClear())
    const mod = await import('../speakers-handlers')
    mod.registerSpeakersHandlers()
  })

  it('transcripts:updateTurns deletes BOTH window and label embeddings for the recording', async () => {
    const handler = handlers.get('transcripts:updateTurns')!
    await handler({}, { recordingId: 'rec_1', turns: [{ speaker: 'A', startMs: 0, endMs: 1000, text: 'x' }] })
    expect(dbMocks.deleteWindowEmbeddingsForRecording).toHaveBeenCalledWith('rec_1')
    // Per-turn reassign must also drop LABEL embeddings so identity/merge scoring recomputes from
    // the new clean-speech set (not just window/mixed). (improvement-high "label embeddings stale".)
    expect(dbMocks.deleteLabelEmbeddingsForRecording).toHaveBeenCalledWith('rec_1')
  })

  it('speakers:merge deletes window embeddings for the recording', async () => {
    const handler = handlers.get('speakers:merge')!
    await handler({}, { recordingId: 'rec_1', fromLabel: 'A', toLabel: 'B' })
    expect(dbMocks.deleteWindowEmbeddingsForRecording).toHaveBeenCalledWith('rec_1')
  })
})
