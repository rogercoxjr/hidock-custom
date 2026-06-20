/**
 * Schema v30 tests — Voice Library Phase 2C diarization-run instrumentation.
 *
 * Uses the REAL sql.js in-memory database; only external boundaries are mocked.
 */
// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { vi } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Hoisted shared state
// ---------------------------------------------------------------------------
const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-v30-'))
  const dataDir = _path.join(tmpDir, 'data')
  _fs.mkdirSync(dataDir, { recursive: true })

  return {
    tmpDir,
    dataDir,
    dbPath: _path.join(dataDir, 'hidock.db')
  }
})

// ---------------------------------------------------------------------------
// External-boundary mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
    getName: vi.fn(() => 'test')
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  Notification: { isSupported: vi.fn(() => false) }
}))

vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    storage: { dataPath: shared.tmpDir, maxRecordingsGB: 50 },
    transcription: {
      provider: 'assemblyai',
      assemblyaiApiKey: 'test-key',
      assemblyaiModels: ['universal-3-pro', 'universal-2'],
      autoTranscribe: false
    }
  })),
  updateConfig: vi.fn(async () => {}),
  getDataPath: vi.fn(() => shared.tmpDir)
}))

vi.mock('../file-storage', () => ({
  getDatabasePath: vi.fn(() => shared.dbPath),
  getRecordingsPath: vi.fn(() => shared.tmpDir),
  getCachePath: vi.fn(() => os.tmpdir()),
  saveRecording: vi.fn(async (filename: string, _data: Buffer) => {
    return path.join(shared.tmpDir, filename)
  })
}))

vi.mock('../vector-store', () => ({
  getVectorStore: vi.fn(() => null)
}))

// ---------------------------------------------------------------------------
// Real service imports
// ---------------------------------------------------------------------------
import {
  initializeDatabase,
  closeDatabase,
  run,
  queryOne,
  queryAll,
  insertDiarizationRun,
  getLatestDiarizationRun,
  getDiarizationRunsForRecording,
  ensureDiarizationSchema,
  upsertTranscriptStage1,
  getTranscriptByRecordingId
} from '../database'

beforeEach(async () => {
  fs.mkdirSync(shared.dataDir, { recursive: true })
  if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
  await initializeDatabase()
})
afterEach(() => { try { closeDatabase() } catch { /* ignore */ } })

describe('v30 voice-library phase-2C schema', () => {
  it('schema_version is 30', () => {
    const ver = queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')
    expect(ver?.version).toBe(30)
  })

  it('diarization_runs table exists with the expected columns', () => {
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

  it('transcripts table has diarization_run_id column', () => {
    const cols = queryAll<{ name: string }>("PRAGMA table_info(transcripts)").map((c) => c.name)
    expect(cols).toContain('diarization_run_id')
  })

  it('diarization_runs index exists', () => {
    const idx = queryOne(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_diar_runs_recording'"
    )
    expect(idx).toBeTruthy()
  })

  it('insertDiarizationRun + getters round-trip', () => {
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

  it('getLatestDiarizationRun returns null when no runs exist', () => {
    expect(getLatestDiarizationRun('no-such-rec')).toBeNull()
  })

  it('getDiarizationRunsForRecording orders newest first', () => {
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

  it('upsertTranscriptStage1 persists and overwrites diarization_run_id', () => {
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

  it('ensureDiarizationSchema self-heals a dropped column and table', () => {
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
