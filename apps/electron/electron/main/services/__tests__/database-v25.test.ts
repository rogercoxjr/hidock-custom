/**
 * Schema v25 tests — auto-pipeline P1 (spec 2026-06-11 §5.8)
 *
 * Uses the REAL sql.js in-memory database (same pattern as e2e-smoke.test.ts):
 * only external boundaries (electron, config, file-storage, vector-store) are
 * mocked; sql.js, fs, and database.ts run their real implementations.
 */
// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { vi } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Hoisted shared state (real temp directory, resolves before vi.mock factories)
// ---------------------------------------------------------------------------
const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-v25-'))
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
      provider: 'gemini',
      geminiApiKey: 'test-key',
      geminiModel: 'gemini-2.0-flash',
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
// Real service imports (resolved AFTER the mocks above)
// ---------------------------------------------------------------------------
import {
  initializeDatabase,
  closeDatabase,
  queryAll,
  queryOne,
  run,
  upsertTranscriptStage1,
  updateTranscriptStage2,
  addToQueue,
  updateQueueItem
} from '../database'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Insert a minimal recording row so transcript FK constraints pass.
 * Mirrors the approach used in e2e-smoke (upsertRecordingFromDevice) but
 * inlined here so this file has no cross-service imports.
 */
function insertTestRecording(id: string): void {
  run(
    `INSERT OR IGNORE INTO recordings
       (id, filename, date_recorded, status, transcription_status, location, on_device, on_local)
     VALUES (?, ?, ?, 'pending', 'none', 'device-only', 1, 0)`,
    [id, `${id}.hda`, new Date().toISOString()]
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('schema v25 (auto-pipeline P1)', () => {
  beforeEach(async () => {
    // Ensure fresh dirs and no stale DB file for each test.
    fs.mkdirSync(shared.dataDir, { recursive: true })
    if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
    await initializeDatabase()
  })

  afterEach(() => {
    try {
      closeDatabase()
    } catch {
      /* ignore */
    }
  })

  it('fresh boot has the four new columns', () => {
    const tCols = queryAll<{ name: string }>("SELECT name FROM pragma_table_info('transcripts')").map(c => c.name)
    expect(tCols).toContain('summarization_provider')
    expect(tCols).toContain('summarization_model')
    const qCols = queryAll<{ name: string }>(
      "SELECT name FROM pragma_table_info('transcription_queue')"
    ).map(c => c.name)
    expect(qCols).toContain('parked_until')
    expect(qCols).toContain('first_parked_at')
  })

  it('fresh boot has sync_baseline_files', () => {
    const t = queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_baseline_files'"
    )
    expect(t?.name).toBe('sync_baseline_files')
  })

  it('backfill marks fused-flow rows complete but leaves NULL-summary rows resumable', async () => {
    // Genuine upgrade-path test: seed legacy-shaped rows, rewind the recorded
    // schema version to 24, then re-init against the SAME db file so the REAL
    // MIGRATIONS[25] (including its actual backfill UPDATE) executes — no
    // hand-copied SQL that could drift from the migration.
    insertTestRecording('rec_legacy_ok')
    insertTestRecording('rec_legacy_null')
    run(`INSERT INTO transcripts (id, recording_id, full_text, language, summary, transcription_model)
         VALUES ('trans_rec_legacy_ok', 'rec_legacy_ok', 'text', 'en', 'a real summary', 'gemini-2.0-flash-exp')`)
    run(`INSERT INTO transcripts (id, recording_id, full_text, language, summary, transcription_model)
         VALUES ('trans_rec_legacy_null', 'rec_legacy_null', 'text', 'en', NULL, 'gemini-2.0-flash-exp')`)

    // Rewind to v24 and force a re-migration. run() persists each statement to
    // disk and closeDatabase() saves again, so the re-init below loads this state.
    run('DELETE FROM schema_version')
    run('INSERT INTO schema_version (version) VALUES (24)')
    closeDatabase()
    await initializeDatabase()

    const ok = queryOne<{ summarization_provider: string }>(
      "SELECT summarization_provider FROM transcripts WHERE recording_id='rec_legacy_ok'")
    const nul = queryOne<{ summarization_provider: string | null }>(
      "SELECT summarization_provider FROM transcripts WHERE recording_id='rec_legacy_null'")
    expect(ok?.summarization_provider).toBe('gemini')
    expect(nul?.summarization_provider).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Task 2: Stage-write functions
// ---------------------------------------------------------------------------

describe('stage-write functions', () => {
  beforeEach(async () => {
    fs.mkdirSync(shared.dataDir, { recursive: true })
    if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
    await initializeDatabase()
  })

  afterEach(() => {
    try {
      closeDatabase()
    } catch {
      /* ignore */
    }
  })

  it('upsertTranscriptStage1 inserts and never touches Stage-2 columns on conflict', () => {
    insertTestRecording('rec_s1')
    upsertTranscriptStage1({
      recording_id: 'rec_s1', full_text: 'v1 text', language: undefined,
      word_count: 2, transcription_provider: 'gemini', transcription_model: 'gemini-2.0-flash-exp'
    })
    // Simulate Stage 2 having completed:
    run(`UPDATE transcripts SET summary='S', summarization_provider='gemini' WHERE recording_id='rec_s1'`)
    // A re-run of Stage 1 (e.g. explicit re-transcribe) must keep Stage-2 columns intact:
    upsertTranscriptStage1({
      recording_id: 'rec_s1', full_text: 'v2 text', language: 'en',
      word_count: 2, transcription_provider: 'gemini', transcription_model: 'gemini-2.0-flash-exp'
    })
    const row = queryOne<{ full_text: string; summary: string; summarization_provider: string; id: string }>(
      "SELECT id, full_text, summary, summarization_provider FROM transcripts WHERE recording_id='rec_s1'")
    expect(row?.full_text).toBe('v2 text')
    expect(row?.summary).toBe('S')                       // untouched
    expect(row?.summarization_provider).toBe('gemini')   // untouched
    expect(row?.id).toBe('trans_rec_s1')                 // id rule preserved
  })

  it('updateTranscriptStage2 writes content + marker atomically and COALESCEs language', () => {
    insertTestRecording('rec_s2')
    upsertTranscriptStage1({
      recording_id: 'rec_s2', full_text: 'hello world', language: undefined,
      word_count: 2, transcription_provider: 'gemini', transcription_model: 'm'
    })
    updateTranscriptStage2('rec_s2', {
      summary: 'sum', action_items: '["a"]', topics: '["t"]', key_points: '["k"]',
      title_suggestion: 'Title', question_suggestions: '["q?"]', language: 'en',
      summarization_provider: 'gemini', summarization_model: 'm'
    })
    const row = queryOne<Record<string, string>>("SELECT * FROM transcripts WHERE recording_id='rec_s2'")
    expect(row?.summary).toBe('sum')
    expect(row?.summarization_provider).toBe('gemini')
    expect(row?.language).toBe('en')   // was NULL from Stage 1 -> analysis language wins
  })

  it('updateTranscriptStage2 does not overwrite an ASR-provided language', () => {
    insertTestRecording('rec_s3')
    upsertTranscriptStage1({
      recording_id: 'rec_s3', full_text: 'hola', language: 'es',
      word_count: 1, transcription_provider: 'openai-whisper', transcription_model: 'whisper-1'
    })
    updateTranscriptStage2('rec_s3', {
      summary: 's', language: 'en', summarization_provider: 'gemini', summarization_model: 'm'
    })
    const row = queryOne<{ language: string }>("SELECT language FROM transcripts WHERE recording_id='rec_s3'")
    expect(row?.language).toBe('es')   // COALESCE keeps the ASR value
  })
})

// ---------------------------------------------------------------------------
// Task 5: addToQueue dedupe (spec §5.7)
// ---------------------------------------------------------------------------

describe('addToQueue dedupe (spec §5.7)', () => {
  beforeEach(async () => {
    fs.mkdirSync(shared.dataDir, { recursive: true })
    if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
    await initializeDatabase()
  })

  afterEach(() => {
    try {
      closeDatabase()
    } catch {
      /* ignore */
    }
  })

  it('returns the existing pending item id instead of inserting a duplicate', () => {
    insertTestRecording('rec_q1')
    const first = addToQueue('rec_q1')
    const second = addToQueue('rec_q1')
    expect(second).toBe(first)   // truthy + identical (return contract)
    const rows = queryAll("SELECT id FROM transcription_queue WHERE recording_id='rec_q1'")
    expect(rows.length).toBe(1)
  })

  it('allows a new item once the prior one is terminal', () => {
    insertTestRecording('rec_q2')
    const first = addToQueue('rec_q2')
    updateQueueItem(first, 'completed')
    const second = addToQueue('rec_q2')
    expect(second).not.toBe(first)
  })
})
