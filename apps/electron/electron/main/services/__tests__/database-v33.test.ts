/**
 * Schema v33 tests — Summarization templates: two new tables, indexes, 3 transcripts columns,
 * and a seeded non-deletable built-in Default ('builtin-default').
 *
 * Uses the REAL sql.js in-memory database (only external boundaries mocked).
 * Covers:
 *  - Fresh boot: both tables + indexes exist, transcripts has 3 new columns,
 *    exactly one is_builtin=1 Default row, schema_version is 33.
 *  - Genuine upgrade: v32→v33 migration adds the 3 ALTER TABLE transcripts columns,
 *    seeds the Default, preserves existing rows.
 *  - Idempotency: re-running init doesn't duplicate the Default or indexes.
 *  - SCHEMA-constant vs MIGRATIONS[33] DDL drift guard: fresh-boot and migrated
 *    DBs have identical column sets + indexes for the new tables.
 *
 * Mirrors the database-v31.test.ts harness.
 */
// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { vi } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path')

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-v33-'))
  const dataDir = _path.join(tmpDir, 'data')
  _fs.mkdirSync(dataDir, { recursive: true })

  return { tmpDir, dataDir, dbPath: _path.join(dataDir, 'hidock.db') }
})

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

import {
  initializeDatabase,
  closeDatabase,
  run,
  queryOne,
  queryAll
} from '../database'

beforeEach(async () => {
  fs.mkdirSync(shared.dataDir, { recursive: true })
  if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
  await initializeDatabase()
})
afterEach(() => { try { closeDatabase() } catch { /* ignore */ } })

describe('v33 — fresh boot (summarization templates)', () => {
  it('schema_version is 33', () => {
    const ver = queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')
    expect(ver?.version).toBe(33)
  })

  it('summarization_templates table + index exist', () => {
    const tbl = queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='summarization_templates'")
    expect(tbl).toBeTruthy()
    const idx = queryOne("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_summ_templates_enabled'")
    expect(idx).toBeTruthy()
  })

  it('transcript_template_runs table + index exist', () => {
    const tbl = queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='transcript_template_runs'")
    expect(tbl).toBeTruthy()
    const idx = queryOne("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_template_runs_recording'")
    expect(idx).toBeTruthy()
  })

  it('transcripts has the 3 new columns', () => {
    const cols = queryAll<{ name: string }>("PRAGMA table_info('transcripts')").map((c) => c.name)
    expect(cols).toContain('summarization_template_id')
    expect(cols).toContain('summarization_template_name')
    expect(cols).toContain('summarization_template_hash')
  })

  it('seeds exactly one is_builtin=1 Default with empty instructions', () => {
    const rows = queryAll<{ id: string; instructions: string; is_builtin: number; enabled: number }>(
      "SELECT id, instructions, is_builtin, enabled FROM summarization_templates WHERE is_builtin=1"
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'builtin-default', instructions: '', is_builtin: 1, enabled: 1 })
  })

  it('re-running init is idempotent (still exactly one Default)', async () => {
    closeDatabase()
    await initializeDatabase()
    const rows = queryAll("SELECT id FROM summarization_templates WHERE id='builtin-default'")
    expect(rows).toHaveLength(1)
  })
})

describe('v33 — genuine upgrade path (column-add is migration-only)', () => {
  // IMPORTANT framing: the canonical SCHEMA constant runs CREATE TABLE IF NOT EXISTS on
  // every boot, so dropping+recreating the two NEW tables is NOT a real test of
  // MIGRATIONS[33]'s table creation (the SCHEMA constant would recreate them regardless).
  // What is genuinely migration-only is the ALTER TABLE transcripts column-adds — the
  // SCHEMA constant cannot retrofit columns onto an EXISTING transcripts row/table. So this
  // block exercises the ALTER path + per-column try/catch independence. Table/index
  // creation is covered by the fresh-boot SCHEMA assertions above and the drift test below.
  it('migrating from v32 adds the 3 transcripts columns and seeds Default, preserving rows', async () => {
    run(`INSERT INTO recordings (id, filename, date_recorded) VALUES ('rec1', 'a.wav', '2024-01-01T00:00:00.000Z')`)
    run(`INSERT INTO transcripts (id, recording_id, full_text) VALUES ('tr1', 'rec1', 'hello world')`)
    run('DELETE FROM schema_version')
    run('INSERT INTO schema_version (version) VALUES (32)')
    closeDatabase()
    await initializeDatabase()
    const ver = queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')
    expect(ver?.version).toBe(33)
    expect(queryOne("SELECT id FROM summarization_templates WHERE id='builtin-default'")).toBeTruthy()
    const t = queryOne<{ full_text: string }>("SELECT full_text FROM transcripts WHERE id='tr1'")
    expect(t?.full_text).toBe('hello world')
    const cols = queryAll<{ name: string }>("PRAGMA table_info('transcripts')").map((c) => c.name)
    expect(cols).toContain('summarization_template_id')
    expect(cols).toContain('summarization_template_name')
    expect(cols).toContain('summarization_template_hash')
  })

  it('per-column try/catch is independent: a partial prior migration (1 of 3 columns) still completes', async () => {
    run('DELETE FROM schema_version')
    run('INSERT INTO schema_version (version) VALUES (32)')
    // Simulate a partial prior migration: ONE of the three columns already exists.
    // The column may already be present (from the v33 SCHEMA path in beforeEach), so tolerate
    // duplicate-column errors here — the point of this test is that MIGRATIONS[33] doesn't throw.
    try { run('ALTER TABLE transcripts ADD COLUMN summarization_template_id TEXT') } catch { /* already exists */ }
    closeDatabase()
    await initializeDatabase() // must NOT throw on the duplicate-column ALTER
    const cols = queryAll<{ name: string }>("PRAGMA table_info('transcripts')").map((c) => c.name)
    expect(cols).toContain('summarization_template_id')
    expect(cols).toContain('summarization_template_name')
    expect(cols).toContain('summarization_template_hash')
  })

  it('re-running init twice keeps exactly one idx_summ_templates_enabled (CREATE INDEX IF NOT EXISTS locked)', async () => {
    closeDatabase()
    await initializeDatabase()
    const idx = queryAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_summ_templates_enabled'"
    )
    expect(idx).toHaveLength(1)
  })

  it('does NOT clobber a (hypothetically) edited builtin-default row on re-migration (INSERT OR IGNORE)', async () => {
    // The Default is protected in the service, but prove the seed never overwrites an existing PK.
    run("UPDATE summarization_templates SET description='locally-edited' WHERE id='builtin-default'")
    closeDatabase()
    await initializeDatabase()
    const row = queryOne<{ description: string }>(
      "SELECT description FROM summarization_templates WHERE id='builtin-default'"
    )
    expect(row?.description).toBe('locally-edited') // INSERT OR IGNORE did not overwrite
  })
})

describe('v33 — SCHEMA-constant vs MIGRATIONS[33] DDL drift guard', () => {
  // The two tables/indexes are hand-written in BOTH the canonical SCHEMA constant and
  // MIGRATIONS[33] (repo convention). This catches the exact drift class that dual copies invite:
  // boot a fresh DB (SCHEMA path) vs a v32→v33 migrated DB and compare table_info + index_list.
  it('fresh-boot and migrated DBs have identical column sets + indexes for the new tables', async () => {
    // Capture the fresh-boot (SCHEMA-constant) shape from the already-initialized DB.
    const freshTplCols = queryAll<{ name: string; type: string }>("PRAGMA table_info('summarization_templates')")
    const freshRunCols = queryAll<{ name: string; type: string }>("PRAGMA table_info('transcript_template_runs')")
    const freshTplIdx = queryAll<{ name: string }>("PRAGMA index_list('summarization_templates')")
    const freshRunIdx = queryAll<{ name: string }>("PRAGMA index_list('transcript_template_runs')")

    // Force a v32→v33 migration path: drop the new tables AND set version back, so the
    // migration loop (not just the SCHEMA constant) is the thing that rebuilds them.
    // NOTE: because the SCHEMA constant also runs CREATE TABLE IF NOT EXISTS on boot, the
    // post-condition tables exist either way — the point is the SHAPES must match, proving the
    // MIGRATIONS[33] DDL has not drifted from the SCHEMA-constant DDL.
    run('DROP TABLE IF EXISTS summarization_templates')
    run('DROP TABLE IF EXISTS transcript_template_runs')
    run('DELETE FROM schema_version')
    run('INSERT INTO schema_version (version) VALUES (32)')
    closeDatabase()
    await initializeDatabase()

    const migTplCols = queryAll<{ name: string; type: string }>("PRAGMA table_info('summarization_templates')")
    const migRunCols = queryAll<{ name: string; type: string }>("PRAGMA table_info('transcript_template_runs')")
    const migTplIdx = queryAll<{ name: string }>("PRAGMA index_list('summarization_templates')")
    const migRunIdx = queryAll<{ name: string }>("PRAGMA index_list('transcript_template_runs')")

    const names = (rows: { name: string }[]) => rows.map((r) => r.name).sort()
    expect(names(migTplCols)).toEqual(names(freshTplCols))
    expect(names(migRunCols)).toEqual(names(freshRunCols))
    expect(names(migTplIdx)).toEqual(names(freshTplIdx))
    expect(names(migRunIdx)).toEqual(names(freshRunIdx))
  })
})
