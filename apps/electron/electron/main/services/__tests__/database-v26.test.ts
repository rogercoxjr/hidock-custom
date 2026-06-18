/**
 * Schema v26 tests — speaker diarization (spec 2026-06-17 §6.3, AC1)
 *
 * Uses the REAL sql.js in-memory database (same pattern as database-v25.test.ts /
 * e2e-smoke.test.ts): only external boundaries (electron, config, file-storage,
 * vector-store) are mocked; sql.js, fs, and database.ts run their real code.
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

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-v26-'))
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

describe('schema v26 (speaker diarization)', () => {
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

  it('fresh boot has the transcripts.turns column', () => {
    const tCols = queryAll<{ name: string }>("SELECT name FROM pragma_table_info('transcripts')").map(c => c.name)
    expect(tCols).toContain('turns')
    // existing speakers/sentiment columns are still present (we reuse them)
    expect(tCols).toContain('speakers')
    expect(tCols).toContain('sentiment')
  })

  it('fresh boot has recording_speakers with the right PK + source CHECK', () => {
    const t = queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='recording_speakers'"
    )
    expect(t?.name).toBe('recording_speakers')
    const cols = queryAll<{ name: string; pk: number }>(
      "SELECT name, pk FROM pragma_table_info('recording_speakers')"
    )
    const colNames = cols.map(c => c.name)
    expect(colNames).toEqual(
      expect.arrayContaining(['recording_id', 'file_label', 'contact_id', 'confidence', 'source', 'created_at'])
    )
    // composite PK is (recording_id, file_label)
    const pkCols = cols.filter(c => c.pk > 0).map(c => c.name).sort()
    expect(pkCols).toEqual(['file_label', 'recording_id'])
  })

  it("recording_speakers rejects a source outside ('user','auto')", () => {
    insertTestRecording('rec_chk')
    expect(() =>
      run(
        `INSERT INTO recording_speakers (recording_id, file_label, source, created_at)
         VALUES ('rec_chk', 'A', 'robot', ?)`,
        [new Date().toISOString()]
      )
    ).toThrow(/CHECK constraint|constraint failed/i)
  })

  it('fresh boot has voiceprints with model_id/dim/embedding BLOB', () => {
    const t = queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='voiceprints'"
    )
    expect(t?.name).toBe('voiceprints')
    const cols = queryAll<{ name: string; type: string }>(
      "SELECT name, type FROM pragma_table_info('voiceprints')"
    )
    const byName = Object.fromEntries(cols.map(c => [c.name, c.type]))
    expect(Object.keys(byName)).toEqual(
      expect.arrayContaining(['id', 'contact_id', 'model_id', 'dim', 'embedding', 'created_at'])
    )
    expect(byName['embedding']).toMatch(/BLOB/i)
    expect(byName['dim']).toMatch(/INTEGER/i)
  })

  it('upgrade path: a v25 DB gains turns + recording_speakers + voiceprints after re-init', async () => {
    // Rewind the recorded version to 25, then re-init the SAME db file so the REAL
    // MIGRATIONS[26] runs (no hand-copied SQL that could drift from the migration).
    run('DELETE FROM schema_version')
    run('INSERT INTO schema_version (version) VALUES (25)')
    closeDatabase()
    await initializeDatabase()

    const tCols = queryAll<{ name: string }>("SELECT name FROM pragma_table_info('transcripts')").map(c => c.name)
    expect(tCols).toContain('turns')
    expect(
      queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='recording_speakers'")
    ).toBeTruthy()
    expect(
      queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='voiceprints'")
    ).toBeTruthy()
    const ver = queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')
    expect(ver?.version).toBe(26)
  })
})
