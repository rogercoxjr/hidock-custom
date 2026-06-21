/**
 * speaker-matcher tests — Phase 2B orchestrator (§3 unit 5).
 *
 * Mocks the DB and voiceprint-service I/O; uses the real pure matcher units.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runMatcher, labelTurnsFingerprint } from '../speaker-matcher'
import * as db from '../../database'
import * as vp from '../../voiceprint-service'
import { VOICEPRINT_MODEL_ID } from '../../voiceprint-service'
import { getConfig } from '../../config'

vi.mock('../../database', () => ({
  getLabelEmbeddingsForRecording: vi.fn(),
  getContactsWithActiveVoiceprints: vi.fn(),
  getActiveVoiceprintsByContactId: vi.fn(),
  getSelfContactId: vi.fn(),
  insertSuggestion: vi.fn(),
  getSuggestionsForRecording: vi.fn(() => []),
  getRecordingSpeaker: vi.fn(),
  getRecordingById: vi.fn(),
  deletePendingSuggestionsForRecording: vi.fn(),
  getTranscriptByRecordingId: vi.fn(),
  getWindowEmbeddingsForRecording: vi.fn(() => []),
  replaceWindowEmbeddingsForLabel: vi.fn(),
  deleteWindowEmbeddingsForRecording: vi.fn(),
}))

vi.mock('../../voiceprint-service', () => ({
  VOICEPRINT_MODEL_ID: '3dspeaker_eres2net_en_voxceleb',
  MIN_CLEAN_SPEECH_MS: 10_000,
  MAX_EMBED_SPEECH_MS: 60_000,
  VOICEPRINT_MODEL_VERSION: 1,
  decodeRecordingPcm16k: vi.fn(() => Promise.resolve(Buffer.alloc(0))),
  embedLabelWindows: vi.fn(() => Promise.resolve([])),
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? '/fake/userdata' : '/fake/home'),
    getAppPath: () => '/fake/app',
    isPackaged: false,
  },
}))

vi.mock('../../config', () => ({
  getConfig: vi.fn(),
}))

/** Default voice-matching config used by the orchestrator. */
const VOICE_MATCHING_DEFAULT = {
  matchSuggest: 0.42,
  matchAuto: 0.55,
  matchMargin: 0.06,
  mergeThreshold: 0.62,
  mixedDispersion: 0.35,
  centroidOutlier: 0.25,
  bankConsistency: 0.35,
  maxMergeSuggestions: 5,
  calibrated: false,
  modelId: '3dspeaker_eres2net_en_voxceleb',
}

/** Float32 values → little-endian BLOB (mirrors private embeddingToBlob). */
function embBlob(values: number[] | Float32Array): Uint8Array {
  const f32 = values instanceof Float32Array ? values : Float32Array.from(values)
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
}

const SAME_VEC = new Float32Array(256).fill(0.5)
const DIFF_VEC = new Float32Array(256).fill(-0.5)

beforeEach(() => {
  vi.mocked(getConfig).mockReset().mockReturnValue({
    privacy: { enableVoiceprintCapture: true, excludeVoiceprintsFromBackup: true },
    voiceMatching: VOICE_MATCHING_DEFAULT,
  } as never)
  vi.mocked(db.getLabelEmbeddingsForRecording).mockReset()
  vi.mocked(db.getContactsWithActiveVoiceprints).mockReset()
  vi.mocked(db.getActiveVoiceprintsByContactId).mockReset()
  vi.mocked(db.getSelfContactId).mockReset().mockReturnValue(null)
  vi.mocked(db.insertSuggestion).mockReset()
  vi.mocked(db.getSuggestionsForRecording).mockReset().mockReturnValue([])
  vi.mocked(db.getRecordingSpeaker).mockReset()
  vi.mocked(db.getRecordingById).mockReset()
  vi.mocked(db.deletePendingSuggestionsForRecording).mockReset()
  vi.mocked(db.getTranscriptByRecordingId).mockReset().mockReturnValue(undefined as never)
  vi.mocked(db.getWindowEmbeddingsForRecording).mockReset().mockReturnValue([] as never)
  vi.mocked(db.replaceWindowEmbeddingsForLabel).mockReset()
  vi.mocked(db.deleteWindowEmbeddingsForRecording).mockReset()
  vi.mocked(vp.decodeRecordingPcm16k).mockReset().mockResolvedValue(Buffer.alloc(0))
  vi.mocked(vp.embedLabelWindows).mockReset().mockResolvedValue([])
})

describe('runMatcher() — Phase 2B orchestrator', () => {
  it('privacy gate returns zero summary when voiceprints disabled', async () => {
    const { getConfig } = await import('../../config')
    vi.mocked(getConfig).mockReturnValue({
      privacy: { enableVoiceprintCapture: false, excludeVoiceprintsFromBackup: true },
      voiceMatching: VOICE_MATCHING_DEFAULT,
    } as never)
    const { summary } = await runMatcher('rec_1')
    expect(summary).toEqual({ identity: 0, merge: 0, mixed: 0, skippedModelMismatch: 0 })
    expect(db.insertSuggestion).not.toHaveBeenCalled()
  })

  it('AC4: counts rows with a stale model_id as skippedModelMismatch and excludes them', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue([
      {
        id: 'le_old',
        recording_id: 'rec_1',
        file_label: 'A',
        model_id: 'stale_model',
        dim: 256,
        embedding: embBlob(SAME_VEC),
        clean_speech_ms: 12_000,
        diarization_run_id: 'drun_1',
      },
      {
        id: 'le_new',
        recording_id: 'rec_1',
        file_label: 'A',
        model_id: VOICEPRINT_MODEL_ID,
        dim: 256,
        embedding: embBlob(SAME_VEC),
        clean_speech_ms: 12_000,
        diarization_run_id: 'drun_1',
      },
    ] as never)
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([] as never)
    const { summary } = await runMatcher('rec_1')
    expect(summary.skippedModelMismatch).toBe(1)
    expect(summary.identity).toBe(0)
    expect(summary.merge).toBe(0)
  })

  it('identity suggestion inserted when one label strongly matches one contact', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue([
      {
        id: 'le_1',
        recording_id: 'rec_1',
        file_label: 'A',
        model_id: VOICEPRINT_MODEL_ID,
        dim: 256,
        embedding: embBlob(SAME_VEC),
        clean_speech_ms: 12_000,
        diarization_run_id: 'drun_1',
      }
    ] as never)
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([{ contact_id: 'c1' }] as never)
    vi.mocked(db.getActiveVoiceprintsByContactId).mockReturnValue([
      {
        id: 'vp_1',
        contact_id: 'c1',
        model_id: VOICEPRINT_MODEL_ID,
        dim: 256,
        embedding: embBlob(SAME_VEC),
        created_at: '2026-01-01T00:00:00.000Z',
      }
    ] as never)
    const { summary } = await runMatcher('rec_1')
    expect(summary.identity).toBe(1)
    expect(db.insertSuggestion).toHaveBeenCalledTimes(1)
    const row = vi.mocked(db.insertSuggestion).mock.calls[0][0]
    expect(row.diarization_run_id).toBe('drun_1')
    expect(row.kind).toBe('identity')
    expect(row.target_label).toBe('A')
    expect(row.contact_id).toBe('c1')
    expect(row.id).toMatch(/^vmsug_rec_1_drun_1_identity_A_c1$/)
  })

  it('same-run dismissed suggestion suppresses re-insertion', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue([
      {
        id: 'le_1',
        recording_id: 'rec_1',
        file_label: 'A',
        model_id: VOICEPRINT_MODEL_ID,
        dim: 256,
        embedding: embBlob(SAME_VEC),
        clean_speech_ms: 12_000,
        diarization_run_id: 'drun_1',
      }
    ] as never)
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([{ contact_id: 'c1' }] as never)
    vi.mocked(db.getActiveVoiceprintsByContactId).mockReturnValue([
      {
        id: 'vp_1',
        contact_id: 'c1',
        model_id: VOICEPRINT_MODEL_ID,
        dim: 256,
        embedding: embBlob(SAME_VEC),
        created_at: '2026-01-01T00:00:00.000Z',
      }
    ] as never)
    vi.mocked(db.getSuggestionsForRecording).mockReturnValue([
      {
        id: 'old',
        recording_id: 'rec_1',
        diarization_run_id: 'drun_1',
        kind: 'identity',
        target_label: 'A',
        contact_id: 'c1',
        status: 'dismissed',
      }
    ] as never)
    const { summary } = await runMatcher('rec_1')
    expect(summary.identity).toBe(0)
    expect(db.insertSuggestion).not.toHaveBeenCalled()
  })

  it('cross-run dismissed suggestion does NOT suppress a new-run suggestion', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue([
      {
        id: 'le_1',
        recording_id: 'rec_1',
        file_label: 'A',
        model_id: VOICEPRINT_MODEL_ID,
        dim: 256,
        embedding: embBlob(SAME_VEC),
        clean_speech_ms: 12_000,
        diarization_run_id: 'drun_new',
      }
    ] as never)
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([{ contact_id: 'c1' }] as never)
    vi.mocked(db.getActiveVoiceprintsByContactId).mockReturnValue([
      {
        id: 'vp_1',
        contact_id: 'c1',
        model_id: VOICEPRINT_MODEL_ID,
        dim: 256,
        embedding: embBlob(SAME_VEC),
        created_at: '2026-01-01T00:00:00.000Z',
      }
    ] as never)
    vi.mocked(db.getSuggestionsForRecording).mockReturnValue([
      {
        id: 'old',
        recording_id: 'rec_1',
        diarization_run_id: 'drun_old',
        kind: 'identity',
        target_label: 'A',
        contact_id: 'c1',
        status: 'dismissed',
      }
    ] as never)
    const { summary } = await runMatcher('rec_1')
    expect(summary.identity).toBe(1)
    expect(db.insertSuggestion).toHaveBeenCalledTimes(1)
    expect(vi.mocked(db.insertSuggestion).mock.calls[0][0].diarization_run_id).toBe('drun_new')
  })

  it('idempotent re-run returns the same summary and does not duplicate inserts', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue([
      {
        id: 'le_1',
        recording_id: 'rec_1',
        file_label: 'A',
        model_id: VOICEPRINT_MODEL_ID,
        dim: 256,
        embedding: embBlob(SAME_VEC),
        clean_speech_ms: 12_000,
        diarization_run_id: 'drun_1',
      }
    ] as never)
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([{ contact_id: 'c1' }] as never)
    vi.mocked(db.getActiveVoiceprintsByContactId).mockReturnValue([
      {
        id: 'vp_1',
        contact_id: 'c1',
        model_id: VOICEPRINT_MODEL_ID,
        dim: 256,
        embedding: embBlob(SAME_VEC),
        created_at: '2026-01-01T00:00:00.000Z',
      }
    ] as never)
    const first = await runMatcher('rec_1')
    const second = await runMatcher('rec_1')
    expect(first.summary).toEqual(second.summary)
    expect(first.diarizationRunId).toBe(second.diarizationRunId)
    expect(first.summary.identity).toBe(1)
    // Two runs → deletePending + insert each time, deterministic id means no duplicate rows.
    expect(vi.mocked(db.insertSuggestion)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(db.insertSuggestion).mock.calls[0][0].id).toBe(
      vi.mocked(db.insertSuggestion).mock.calls[1][0].id
    )
  })

  it('merge suggestion inserted for two identical labels with no contacts', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue([
      {
        id: 'le_A',
        recording_id: 'rec_1',
        file_label: 'A',
        model_id: VOICEPRINT_MODEL_ID,
        dim: 256,
        embedding: embBlob(SAME_VEC),
        clean_speech_ms: 12_000,
        diarization_run_id: 'drun_1',
      },
      {
        id: 'le_B',
        recording_id: 'rec_1',
        file_label: 'B',
        model_id: VOICEPRINT_MODEL_ID,
        dim: 256,
        embedding: embBlob(SAME_VEC),
        clean_speech_ms: 8_000,
        diarization_run_id: 'drun_1',
      }
    ] as never)
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([] as never)
    const { summary } = await runMatcher('rec_1')
    expect(summary.merge).toBe(1)
    const row = vi.mocked(db.insertSuggestion).mock.calls[0][0]
    expect(row.kind).toBe('merge')
    expect(row.target_label).toBe('A')
    expect(row.target_label_2).toBe('B')
  })

  it('mixed suggestion inserted for a long label with two orthogonal window embeddings', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue([
      {
        id: 'le_M',
        recording_id: 'rec_1',
        file_label: 'M',
        model_id: VOICEPRINT_MODEL_ID,
        dim: 256,
        embedding: embBlob(SAME_VEC),
        clean_speech_ms: 25_000,
        diarization_run_id: 'drun_1',
      }
    ] as never)
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([] as never)
    vi.mocked(db.getRecordingById).mockReturnValue({ id: 'rec_1', file_path: '/r/rec.wav' } as never)
    // Two window embeddings pointing in opposite directions → high dispersion.
    vi.mocked(vp.embedLabelWindows).mockResolvedValue([DIFF_VEC, SAME_VEC])
    const { summary } = await runMatcher('rec_1')
    expect(summary.mixed).toBe(1)
    const row = vi.mocked(db.insertSuggestion).mock.calls[0][0]
    expect(row.kind).toBe('mixed')
    expect(row.target_label).toBe('M')
  })

  /** A long label whose window embeddings drive mixed detection. */
  const longLabelRows = (runId: string) =>
    [
      {
        id: 'le_M',
        recording_id: 'rec_1',
        file_label: 'M',
        model_id: VOICEPRINT_MODEL_ID,
        dim: 256,
        embedding: embBlob(SAME_VEC),
        clean_speech_ms: 25_000,
        diarization_run_id: runId,
      },
    ] as never

  // obsolete in-memory-cache assertion — rewritten DB-backed in Task 7
  it.skip('perf: caches window embeddings per (recording, run) — re-run does NOT re-decode/re-embed', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue(longLabelRows('drun_1'))
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([] as never)
    vi.mocked(db.getRecordingById).mockReturnValue({ id: 'rec_1', file_path: '/r/rec.wav' } as never)
    vi.mocked(vp.embedLabelWindows).mockResolvedValue([DIFF_VEC, SAME_VEC])

    await runMatcher('rec_1')
    await runMatcher('rec_1')
    await runMatcher('rec_1')

    // The expensive decode + per-window inference run ONCE for the run, not per call.
    expect(vi.mocked(vp.decodeRecordingPcm16k)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(vp.embedLabelWindows)).toHaveBeenCalledTimes(1)
    // But suggestions are still produced on every call (scoring re-runs).
    expect(vi.mocked(db.insertSuggestion).mock.calls.filter((c) => c[0].kind === 'mixed').length).toBe(3)
  })

  // obsolete in-memory-cache assertion — rewritten DB-backed in Task 7
  it.skip('perf: a new diarization run id re-decodes/re-embeds (cache keyed by run)', async () => {
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([] as never)
    vi.mocked(db.getRecordingById).mockReturnValue({ id: 'rec_1', file_path: '/r/rec.wav' } as never)
    vi.mocked(vp.embedLabelWindows).mockResolvedValue([DIFF_VEC, SAME_VEC])

    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue(longLabelRows('drun_1'))
    await runMatcher('rec_1')
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue(longLabelRows('drun_2'))
    await runMatcher('rec_1')

    expect(vi.mocked(vp.decodeRecordingPcm16k)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(vp.embedLabelWindows)).toHaveBeenCalledTimes(2)
  })
})

describe('runMatcher() — DB-backed window embeddings', () => {
  const longRows = [
    {
      id: 'le_M', recording_id: 'rec_1', file_label: 'M', model_id: VOICEPRINT_MODEL_ID,
      dim: 256, embedding: embBlob(SAME_VEC), clean_speech_ms: 25_000, diarization_run_id: 'drun_1',
    },
  ] as never
  const turns = [
    { speaker: 'M', startMs: 0, endMs: 22_000, text: 'a' },
    { speaker: 'M', startMs: 22_000, endMs: 44_000, text: 'b' },
  ]

  it('first call computes + persists window embeddings via replaceWindowEmbeddingsForLabel', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue(longRows)
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([] as never)
    vi.mocked(db.getRecordingById).mockReturnValue({ id: 'rec_1', file_path: '/r/rec.wav' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({ id: 't1', turns: JSON.stringify(turns) } as never)
    vi.mocked(db.getWindowEmbeddingsForRecording).mockReturnValue([] as never) // DB empty → miss
    vi.mocked(vp.embedLabelWindows).mockResolvedValue([DIFF_VEC, SAME_VEC])

    await runMatcher('rec_1')

    expect(vi.mocked(vp.decodeRecordingPcm16k)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(vp.embedLabelWindows)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(db.replaceWindowEmbeddingsForLabel)).toHaveBeenCalledTimes(1)
    const [rid, lbl, inserted] = vi.mocked(db.replaceWindowEmbeddingsForLabel).mock.calls[0]
    expect(rid).toBe('rec_1')
    expect(lbl).toBe('M')
    expect(inserted.length).toBe(2) // two windows
    expect(inserted[0].window_index).toBe(0)
    expect(inserted[1].window_index).toBe(1)
    expect(inserted[0].diarization_run_id).toBe('drun_1') // run id passed through from runMatcher
    const fp = labelTurnsFingerprint(turns as never, 'M', VOICEPRINT_MODEL_ID, 1)
    expect(inserted[0].fingerprint).toBe(fp)
  })

  it('second call (DB hit, matching fingerprint) reads from DB, no decode/embed', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue(longRows)
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([] as never)
    vi.mocked(db.getRecordingById).mockReturnValue({ id: 'rec_1', file_path: '/r/rec.wav' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({ id: 't1', turns: JSON.stringify(turns) } as never)
    const fp = labelTurnsFingerprint(turns as never, 'M', VOICEPRINT_MODEL_ID, 1)
    vi.mocked(db.getWindowEmbeddingsForRecording).mockReturnValue([
      { fileLabel: 'M', fingerprint: fp, embeddings: [embBlob(DIFF_VEC), embBlob(SAME_VEC)] },
    ] as never)

    const { summary } = await runMatcher('rec_1')

    expect(vi.mocked(vp.decodeRecordingPcm16k)).not.toHaveBeenCalled()
    expect(vi.mocked(vp.embedLabelWindows)).not.toHaveBeenCalled()
    expect(vi.mocked(db.replaceWindowEmbeddingsForLabel)).not.toHaveBeenCalled()
    expect(summary.mixed).toBe(1) // scoring still re-runs and yields the mixed suggestion
  })

  it('stale fingerprint (edited turns) recomputes only that label and replaces its rows', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue(longRows)
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([] as never)
    vi.mocked(db.getRecordingById).mockReturnValue({ id: 'rec_1', file_path: '/r/rec.wav' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({ id: 't1', turns: JSON.stringify(turns) } as never)
    vi.mocked(db.getWindowEmbeddingsForRecording).mockReturnValue([
      { fileLabel: 'M', fingerprint: 'STALE_FINGERPRINT', embeddings: [embBlob(SAME_VEC)] },
    ] as never)
    vi.mocked(vp.embedLabelWindows).mockResolvedValue([DIFF_VEC, SAME_VEC])

    await runMatcher('rec_1')

    expect(vi.mocked(vp.embedLabelWindows)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(db.replaceWindowEmbeddingsForLabel)).toHaveBeenCalledWith(
      'rec_1', 'M', expect.arrayContaining([expect.objectContaining({ window_index: 0 })])
    )
  })

  it('zero-window label persists an empty tombstone and is a hit (no re-decode) next call', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue(longRows)
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([] as never)
    vi.mocked(db.getRecordingById).mockReturnValue({ id: 'rec_1', file_path: '/r/rec.wav' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({ id: 't1', turns: JSON.stringify(turns) } as never)
    // First call: DB empty, embed yields zero windows → tombstone persisted.
    vi.mocked(db.getWindowEmbeddingsForRecording).mockReturnValueOnce([] as never)
    vi.mocked(vp.embedLabelWindows).mockResolvedValueOnce([])

    await runMatcher('rec_1')

    expect(vi.mocked(db.replaceWindowEmbeddingsForLabel)).toHaveBeenCalledTimes(1)
    const [, , rows] = vi.mocked(db.replaceWindowEmbeddingsForLabel).mock.calls[0]
    expect(rows.length).toBe(1)
    expect(rows[0].window_index).toBe(-1) // sentinel
    expect(rows[0].dim).toBe(0)
    expect(rows[0].embedding.byteLength).toBe(0)

    // Second call: the tombstone (matching fingerprint, 0-byte blob) is a hit → no decode/embed.
    const fp = labelTurnsFingerprint(turns as never, 'M', VOICEPRINT_MODEL_ID, 1)
    vi.mocked(db.getWindowEmbeddingsForRecording).mockReturnValue([
      { fileLabel: 'M', fingerprint: fp, embeddings: [new Uint8Array(0)] },
    ] as never)
    vi.mocked(vp.decodeRecordingPcm16k).mockClear()
    vi.mocked(vp.embedLabelWindows).mockClear()

    await runMatcher('rec_1')

    expect(vi.mocked(vp.decodeRecordingPcm16k)).not.toHaveBeenCalled()
    expect(vi.mocked(vp.embedLabelWindows)).not.toHaveBeenCalled()
  })
})
