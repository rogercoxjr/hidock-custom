/**
 * Schema v31 tests — Smart Labels: drop the CHECK constraint on
 * knowledge_captures.category.
 *
 * Backed by the REAL better-sqlite3 database (canonical harness — see
 * database.boot.test.ts): each test gets a fresh HIDOCK_DATA_ROOT temp dir +
 * vi.resetModules(), then initializeFileStorage() + initializeDatabase() build
 * the real schema on disk. Covers BOTH paths:
 *  - Fresh boot: the relaxed (no-CHECK) column accepts user-defined categories,
 *    schema_version is at head (33), and the category index exists.
 *  - Genuine upgrade: a v30-shaped table WITH the old CHECK is rebuilt by the
 *    real MIGRATIONS[31]. Asserts all rows + categories preserved, the category
 *    index recreated, and CASCADE children (action_items, which carry the
 *    knowledge_capture_id FK with ON DELETE CASCADE) still resolve to parents.
 */
// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string

beforeEach(() => {
  vi.resetModules()
  dir = mkdtempSync(join(tmpdir(), 'hidock-v31-'))
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

describe('v31 — fresh boot (relaxed category column)', () => {
  it('schema_version is 31 (now advances to 33 as current head)', async () => {
    const { queryOne } = await boot()
    const ver = queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')
    expect(ver?.version).toBe(33)
  })

  it('knowledge_captures.category has NO CHECK (a user-defined label is storable)', async () => {
    const { run, queryOne } = await boot()
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

  it('the category index exists', async () => {
    const { queryOne } = await boot()
    const idx = queryOne(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_knowledge_captures_category'"
    )
    expect(idx).toBeTruthy()
  })
})

describe('v31 — genuine upgrade path (CHECK-drop rebuild)', () => {
  it('preserves all rows + categories, recreates the index, keeps CASCADE children resolvable', async () => {
    const { run, closeDatabase } = await boot()

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
    const db2 = await import('../database')
    await db2.initializeDatabase()

    // --- Assert: version bumped (to current head, which is now 33) ---
    const ver = db2.queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')
    expect(ver?.version).toBe(33)

    // --- Assert: CHECK is gone ---
    const createSql = db2.queryOne<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_captures'"
    )?.sql ?? ''
    expect(createSql).not.toMatch(/category[^,]*CHECK/i)

    // --- Assert: every row + its category preserved verbatim ---
    const rows = db2.queryAll<{ id: string; title: string; category: string }>(
      'SELECT id, title, category FROM knowledge_captures ORDER BY id'
    )
    expect(rows).toEqual([
      { id: 'kc1', title: 'Cap One', category: 'meeting' },
      { id: 'kc2', title: 'Cap Two', category: 'interview' },
      { id: 'kc3', title: 'Cap Three', category: '1:1' }
    ])

    // --- Assert: category index recreated ---
    const idx = db2.queryOne(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_knowledge_captures_category'"
    )
    expect(idx).toBeTruthy()

    // --- Assert: CASCADE children still resolve to their (preserved) parents ---
    const joined = db2.queryAll<{ tid: string; kc_id: string; cat: string }>(
      `SELECT t.id AS tid, kc.id AS kc_id, kc.category AS cat
       FROM action_items t JOIN knowledge_captures kc ON kc.id = t.knowledge_capture_id
       ORDER BY t.id`
    )
    expect(joined).toEqual([
      { tid: 't1', kc_id: 'kc1', cat: 'meeting' },
      { tid: 't2', kc_id: 'kc2', cat: 'interview' }
    ])
    // No orphaned children.
    const orphans = db2.queryAll(
      `SELECT t.id FROM action_items t
       LEFT JOIN knowledge_captures kc ON kc.id = t.knowledge_capture_id
       WHERE t.knowledge_capture_id IS NOT NULL AND kc.id IS NULL`
    )
    expect(orphans).toHaveLength(0)

    // --- Assert: a user-defined category is now storable post-migration ---
    db2.run(`UPDATE knowledge_captures SET category='sales-call' WHERE id='kc3'`)
    expect(
      db2.queryOne<{ category: string }>("SELECT category FROM knowledge_captures WHERE id='kc3'")?.category
    ).toBe('sales-call')
  })
})
