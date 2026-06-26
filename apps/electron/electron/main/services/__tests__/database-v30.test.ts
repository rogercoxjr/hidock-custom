/**
 * Schema v30 tests — Voice Library Phase 2C diarization-run instrumentation.
 *
 * Backed by the REAL better-sqlite3 database (canonical harness — see
 * database.boot.test.ts / database.functions.test.ts): each test gets a fresh
 * HIDOCK_DATA_ROOT temp dir + vi.resetModules(), then initializeFileStorage()
 * and initializeDatabase() build the real schema on disk. No mocks — the schema,
 * migrations, and query helpers all run their real implementations.
 */
// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string

beforeEach(() => {
  vi.resetModules()
  dir = mkdtempSync(join(tmpdir(), 'hidock-v30-'))
  process.env.HIDOCK_DATA_ROOT = dir
})

afterEach(async () => {
  const { closeDatabase } = await import('../database')
  try { closeDatabase() } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true })
  delete process.env.HIDOCK_DATA_ROOT
})

/** Boot the real file storage + database for the current temp root. */
async function boot() {
  const { initializeFileStorage } = await import('../file-storage')
  const db = await import('../database')
  await initializeFileStorage()
  await db.initializeDatabase()
  return db
}

describe('v30 voice-library phase-2C schema', () => {
  it('schema_version is at current head (34)', async () => {
    const { queryOne } = await boot()
    const ver = queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')
    expect(ver?.version).toBe(34)
  })

  it('diarization_runs table exists with the expected columns', async () => {
    const { queryAll } = await boot()
    const cols = queryAll<{ name: string }>("PRAGMA table_info(diarization_runs)").map((c) => c.name)
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'recording_id',
        'transcript_id',
        'provider',
        'model',
        'options_min',
        'options_max',
        'options_sent_json',
        'label_count',
        'is_solo',
        'solo_reason',
        'failure_reason',
        'duration_ms',
        'policy_version',
        'created_at'
      ])
    )
  })

  it('transcripts table has diarization_run_id column', async () => {
    const { queryAll } = await boot()
    const cols = queryAll<{ name: string }>("PRAGMA table_info(transcripts)").map((c) => c.name)
    expect(cols).toContain('diarization_run_id')
  })

  it('diarization_runs index exists', async () => {
    const { queryOne } = await boot()
    const idx = queryOne(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_diar_runs_recording'"
    )
    expect(idx).toBeTruthy()
  })

  it('insertDiarizationRun + getters round-trip', async () => {
    const { insertDiarizationRun, getLatestDiarizationRun, getDiarizationRunsForRecording } = await boot()
    const id = 'diar_test_roundtrip'
    insertDiarizationRun({
      id,
      recording_id: 'rec-1',
      transcript_id: 'trans_rec-1',
      provider: 'assemblyai',
      model: 'universal-3-pro',
      options_min: 1,
      options_max: 8,
      options_sent_json: JSON.stringify({ min_speakers_expected: 1, max_speakers_expected: 8 }),
      label_count: 3,
      is_solo: 0,
      solo_reason: undefined,
      failure_reason: undefined,
      duration_ms: 300000,
      policy_version: 1,
      created_at: '2026-06-19T12:00:00.000Z'
    })

    const latest = getLatestDiarizationRun('rec-1')
    expect(latest).not.toBeNull()
    expect(latest?.id).toBe(id)
    expect(latest?.recording_id).toBe('rec-1')
    expect(latest?.label_count).toBe(3)
    expect(latest?.is_solo).toBe(0)
    expect(latest?.options_min).toBe(1)
    expect(latest?.options_max).toBe(8)

    const all = getDiarizationRunsForRecording('rec-1')
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(id)
  })

  it('getLatestDiarizationRun returns null when no runs exist', async () => {
    const { getLatestDiarizationRun } = await boot()
    expect(getLatestDiarizationRun('no-such-rec')).toBeNull()
  })

  it('getDiarizationRunsForRecording orders newest first', async () => {
    const { insertDiarizationRun, getLatestDiarizationRun, getDiarizationRunsForRecording } = await boot()
    insertDiarizationRun({
      id: 'diar_old',
      recording_id: 'rec-3',
      transcript_id: 'trans_rec-3',
      provider: 'assemblyai',
      label_count: 2,
      is_solo: 0,
      created_at: '2026-06-19T10:00:00.000Z'
    })
    insertDiarizationRun({
      id: 'diar_new',
      recording_id: 'rec-3',
      transcript_id: 'trans_rec-3',
      provider: 'assemblyai',
      label_count: 3,
      is_solo: 0,
      created_at: '2026-06-19T14:00:00.000Z'
    })

    const latest = getLatestDiarizationRun('rec-3')
    expect(latest?.id).toBe('diar_new')

    const all = getDiarizationRunsForRecording('rec-3')
    expect(all.map((r) => r.id)).toEqual(['diar_new', 'diar_old'])
  })

  it('upsertTranscriptStage1 persists and overwrites diarization_run_id', async () => {
    const { run, insertDiarizationRun, upsertTranscriptStage1, getTranscriptByRecordingId } = await boot()

    // Insert a parent recordings row. Harmless defensive setup — the real boot now runs with
    // foreign_keys=OFF (faithful to prior sql.js), so this isn't strictly required, but it keeps
    // the fixture realistic and safe in case FK enforcement is enabled in the future.
    run(
      `INSERT INTO recordings (id, filename, date_recorded) VALUES (?, ?, ?)`,
      ['rec-2', 'rec2.wav', '2026-06-19T11:00:00.000Z']
    )

    insertDiarizationRun({
      id: 'diar_run_old',
      recording_id: 'rec-2',
      transcript_id: 'trans_rec-2',
      provider: 'assemblyai',
      label_count: 1,
      is_solo: 1,
      solo_reason: 'single_label',
      duration_ms: 120000,
      policy_version: 1,
      created_at: '2026-06-19T12:00:00.000Z'
    })

    upsertTranscriptStage1({
      recording_id: 'rec-2',
      full_text: 'hello world',
      transcription_provider: 'assemblyai',
      diarization_run_id: 'diar_run_old'
    })
    upsertTranscriptStage1({
      recording_id: 'rec-2',
      full_text: 're-transcribed flat',
      transcription_provider: 'openai-whisper',
      diarization_run_id: undefined
    })

    const t = getTranscriptByRecordingId('rec-2')
    expect(t?.diarization_run_id).toBeNull()
  })

  it('ensureDiarizationSchema self-heals a dropped column and table', async () => {
    const { run, ensureDiarizationSchema, queryAll, queryOne } = await boot()
    // Simulate a partially-corrupted restored backup by removing the column and index.
    run('ALTER TABLE transcripts DROP COLUMN diarization_run_id')
    run('DROP INDEX idx_diar_runs_recording')

    ensureDiarizationSchema()

    const cols = queryAll<{ name: string }>("PRAGMA table_info(transcripts)").map((c) => c.name)
    expect(cols).toContain('diarization_run_id')

    const idx = queryOne(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_diar_runs_recording'"
    )
    expect(idx).toBeTruthy()
  })
})
