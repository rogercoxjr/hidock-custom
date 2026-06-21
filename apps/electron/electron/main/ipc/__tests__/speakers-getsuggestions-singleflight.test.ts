import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: class {},
}))

const embedRecordingLabels = vi.fn(async () => {})
let resolveMatcher: (v: { diarizationRunId: string | null }) => void
const runMatcher = vi.fn(
  () => new Promise<{ diarizationRunId: string | null }>((res) => { resolveMatcher = res })
)

vi.mock('../../services/voiceprint-service', () => ({
  embedRecordingLabels: (...a: unknown[]) => embedRecordingLabels(...a),
}))
vi.mock('../../services/voiceprint/speaker-matcher', () => ({
  runMatcher: () => runMatcher(),
}))
vi.mock('../../services/database', () => ({
  upsertRecordingSpeaker: vi.fn(), deleteRecordingSpeaker: vi.fn(), getRecordingSpeaker: vi.fn(),
  getRecordingSpeakers: vi.fn(() => []), getContactById: vi.fn(), getTranscriptByRecordingId: vi.fn(),
  updateTranscriptTurns: vi.fn(), deleteVoiceprintsBySource: vi.fn(),
  getPendingSuggestions: vi.fn(() => []), getSelfContactId: vi.fn(),
  deleteLabelEmbeddingsForRecording: vi.fn(), deleteWindowEmbeddingsForRecording: vi.fn(),
  expireSuggestionsForRecording: vi.fn(), acceptSuggestion: vi.fn(), dismissSuggestion: vi.fn(),
}))

describe('speakers:getSuggestions single-flight', () => {
  beforeEach(async () => {
    handlers.clear()
    embedRecordingLabels.mockClear()
    runMatcher.mockClear()
    const mod = await import('../speakers-handlers')
    mod.registerSpeakersHandlers()
  })

  it('two overlapping calls for the same recording run embed+match once', async () => {
    const handler = handlers.get('speakers:getSuggestions')!
    const p1 = handler({}, 'rec_X')
    const p2 = handler({}, 'rec_X')
    // Let the first call reach the pending runMatcher promise.
    await new Promise((r) => setImmediate(r))
    resolveMatcher({ diarizationRunId: 'drun_1' })
    await Promise.all([p1, p2])

    expect(embedRecordingLabels).toHaveBeenCalledTimes(1)
    expect(runMatcher).toHaveBeenCalledTimes(1)
  })

  it('a rejected embed is shared by both callers (each gets []) and the entry clears for a retry', async () => {
    const handler = handlers.get('speakers:getSuggestions')!
    // First wave: embed rejects → both callers get the handler's [] result.
    embedRecordingLabels.mockRejectedValueOnce(new Error('decode boom') as never)
    const [r1, r2] = await Promise.all([handler({}, 'rec_Y'), handler({}, 'rec_Y')])
    expect((r1 as { success: boolean; data: unknown[] }).data).toEqual([])
    expect((r2 as { success: boolean; data: unknown[] }).data).toEqual([])
    expect(embedRecordingLabels).toHaveBeenCalledTimes(1) // shared, not double

    // Second wave: the entry was cleared on settle, so a fresh call re-invokes embed+match.
    embedRecordingLabels.mockResolvedValueOnce(undefined as never)
    const p = handler({}, 'rec_Y')
    await new Promise((r) => setImmediate(r))
    resolveMatcher({ diarizationRunId: 'drun_2' })
    await p
    expect(embedRecordingLabels).toHaveBeenCalledTimes(2)
    expect(runMatcher).toHaveBeenCalledTimes(1) // first wave never reached runMatcher (embed threw)
  })
})
