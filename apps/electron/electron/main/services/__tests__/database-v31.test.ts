/**
 * Schema v31 tests — Smart Labels: drop the CHECK constraint on
 * knowledge_captures.category.
 *
 * Uses the REAL sql.js in-memory database (only external boundaries mocked).
 * Covers BOTH paths:
 *  - Fresh boot: the relaxed (no-CHECK) column accepts user-defined categories,
 *    schema_version is 31, and the category index exists.
 *  - Genuine upgrade: a v30-shaped table WITH the old CHECK is rebuilt by the
 *    real MIGRATIONS[31]. Asserts all rows + categories preserved, the category
 *    index recreated, and CASCADE children (action_items, which carry the
 *    knowledge_capture_id FK with ON DELETE CASCADE) still resolve to parents.
 *
 * Mirrors the database-v30 / database-v25 harness.
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

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'hidock-v31-'))
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

describe('v31 — fresh boot (relaxed category column)', () => {
  it('schema_version is 31 (now advances to 33 as current head)', () => {
    const ver = queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')
    expect(ver?.version).toBe(33)
  })

  it('knowledge_captures.category has NO CHECK (a user-defined label is storable)', () => {
    const createSql = queryOne<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_captures'"
    )?.sql ?? ''
    expect(createSql).not.toMatch(/category[^,]*CHECK/i)

    // The decisive behavioral check: store a category the old CHECK would have rejected.
    run(
      `INSERT INTO knowledge_captures (id, title, category, captured_at)
       VALUES ('kc_custom', 'Custom', 'sales-call', '2026-06-20T00:00:00Z')`
    )
    const row = queryOne<{ category: string }>("SELECT category FROM knowledge_captures WHERE id='kc_custom'")
    expect(row?.category).toBe('sales-call')
  })

  it('the category index exists', () => {
    const idx = queryOne(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_knowledge_captures_category'"
    )
    expect(idx).toBeTruthy()
  })
})

describe('v31 — genuine upgrade path (CHECK-drop rebuild)', () => {
  it('preserves all rows + categories, recreates the index, keeps CASCADE children resolvable', async () => {
    // 1. Reconstruct a v30-shaped knowledge_captures WITH the old CHECK, so the real
    //    MIGRATIONS[31] rebuild branch actually fires (a fresh DB is already relaxed).
    run('DROP TABLE knowledge_captures')
    run(`
      CREATE TABLE knowledge_captures (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT,
        category TEXT CHECK(category IN ('meeting', 'interview', '1:1', 'brainstorm', 'note', 'other')) DEFAULT 'meeting',
        status TEXT CHECK(status IN ('processing', 'ready', 'enriched')) DEFAULT 'ready',
        quality_rating TEXT CHECK(quality_rating IN ('valuable', 'archived', 'low-value', 'garbage', 'unrated')) DEFAULT 'unrated',
        quality_confidence REAL,
        quality_assessed_at TEXT,
        storage_tier TEXT CHECK(storage_tier IN ('hot', 'cold', 'expiring', 'deleted')) DEFAULT 'hot',
        retention_days INTEGER,
        expires_at TEXT,
        meeting_id TEXT,
        correlation_confidence REAL,
        correlation_method TEXT,
        source_recording_id TEXT,
        captured_at TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        deleted_at TEXT,
        FOREIGN KEY (meeting_id) REFERENCES meetings(id),
        FOREIGN KEY (source_recording_id) REFERENCES recordings(id)
      )
    `)
    run('CREATE INDEX IF NOT EXISTS idx_knowledge_captures_category ON knowledge_captures(category)')

    // 2. Seed parent rows (with built-in categories the old CHECK accepts) + CASCADE children.
    run(`INSERT INTO knowledge_captures (id, title, category, captured_at)
         VALUES ('kc1', 'Cap One', 'meeting', '2026-06-20T00:00:00Z')`)
    run(`INSERT INTO knowledge_captures (id, title, category, captured_at)
         VALUES ('kc2', 'Cap Two', 'interview', '2026-06-20T01:00:00Z')`)
    run(`INSERT INTO knowledge_captures (id, title, category, captured_at)
         VALUES ('kc3', 'Cap Three', '1:1', '2026-06-20T02:00:00Z')`)

    // action_items CASCADE-references knowledge_captures(id) via knowledge_capture_id.
    run(`INSERT INTO action_items (id, knowledge_capture_id, content)
         VALUES ('t1', 'kc1', 'do thing one')`)
    run(`INSERT INTO action_items (id, knowledge_capture_id, content)
         VALUES ('t2', 'kc2', 'do thing two')`)

    // 3. Rewind the recorded schema version to 30 and re-init the SAME db file so the
    //    REAL MIGRATIONS[31] executes against this v30-shaped table.
    run('DELETE FROM schema_version')
    run('INSERT INTO schema_version (version) VALUES (30)')
    closeDatabase()
    await initializeDatabase()

    // --- Assert: version bumped (to current head, which is now 33) ---
    const ver = queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')
    expect(ver?.version).toBe(33)

    // --- Assert: CHECK is gone ---
    const createSql = queryOne<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_captures'"
    )?.sql ?? ''
    expect(createSql).not.toMatch(/category[^,]*CHECK/i)

    // --- Assert: every row + its category preserved verbatim ---
    const rows = queryAll<{ id: string; title: string; category: string }>(
      'SELECT id, title, category FROM knowledge_captures ORDER BY id'
    )
    expect(rows).toEqual([
      { id: 'kc1', title: 'Cap One', category: 'meeting' },
      { id: 'kc2', title: 'Cap Two', category: 'interview' },
      { id: 'kc3', title: 'Cap Three', category: '1:1' }
    ])

    // --- Assert: category index recreated ---
    const idx = queryOne(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_knowledge_captures_category'"
    )
    expect(idx).toBeTruthy()

    // --- Assert: CASCADE children still resolve to their (preserved) parents ---
    const joined = queryAll<{ tid: string; kc_id: string; cat: string }>(
      `SELECT t.id AS tid, kc.id AS kc_id, kc.category AS cat
       FROM action_items t JOIN knowledge_captures kc ON kc.id = t.knowledge_capture_id
       ORDER BY t.id`
    )
    expect(joined).toEqual([
      { tid: 't1', kc_id: 'kc1', cat: 'meeting' },
      { tid: 't2', kc_id: 'kc2', cat: 'interview' }
    ])
    // No orphaned children.
    const orphans = queryAll(
      `SELECT t.id FROM action_items t
       LEFT JOIN knowledge_captures kc ON kc.id = t.knowledge_capture_id
       WHERE t.knowledge_capture_id IS NOT NULL AND kc.id IS NULL`
    )
    expect(orphans).toHaveLength(0)

    // --- Assert: a user-defined category is now storable post-migration ---
    run(`UPDATE knowledge_captures SET category='sales-call' WHERE id='kc3'`)
    expect(
      queryOne<{ category: string }>("SELECT category FROM knowledge_captures WHERE id='kc3'")?.category
    ).toBe('sales-call')
  })
})
