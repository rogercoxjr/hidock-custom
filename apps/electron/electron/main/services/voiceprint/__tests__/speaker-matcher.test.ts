/**
 * speaker-matcher tests — Phase 2B orchestrator (§3 unit 5).
 *
 * Mocks the DB and voiceprint-service I/O; uses the real pure matcher units.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runMatcher } from '../speaker-matcher'
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
}))

vi.mock('../../voiceprint-service', () => ({
  VOICEPRINT_MODEL_ID: '3dspeaker_eres2net_en_voxceleb',
  MIN_CLEAN_SPEECH_MS: 10_000,
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
})
