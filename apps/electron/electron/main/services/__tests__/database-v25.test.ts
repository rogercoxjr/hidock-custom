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
  saveRecording: vi.fn(async (filename: string, data: Buffer) => {
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
  run
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
