import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let tmpDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? tmpDir : tmpDir),
    getAppPath: () => '/fake/app',
    isPackaged: false,
  },
}))

describe('recording_window_embeddings schema (v32)', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rwe-schema-'))
    // DEFAULT_CONFIG.storage.dataPath = join(app.getPath('home'), 'HiDock') = tmpDir/HiDock
    // getDatabasePath() = tmpDir/HiDock/data/hidock.db — pre-create so saveDatabase() can write
    mkdirSync(join(tmpDir, 'HiDock', 'data'), { recursive: true })
    vi.resetModules()
  })
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('creates the table and index and reports schema v32', async () => {
    const db = await import('../database')
    await db.initializeDatabase()
    const dbi = db.getDatabase()

    const tbl = dbi.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='recording_window_embeddings'"
    )
    expect(tbl.length).toBe(1)

    const idx = dbi.exec(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_rwe_recording_label'"
    )
    expect(idx.length).toBe(1)

    const ver = dbi.exec('SELECT MAX(version) FROM schema_version')
    expect(ver[0].values[0][0]).toBe(32)
  })

  // The fresh-init test above takes the `currentVersion === 0` branch (database.ts:1948-1949),
  // which inserts SCHEMA_VERSION directly and gets the table from the canonical SCHEMA — it NEVER
  // executes MIGRATIONS[32]. This test forces the migration path: init once, then rewind the
  // schema_version row to 31 AND drop the table, then re-run initializeDatabase so currentVersion
  // (31) < SCHEMA_VERSION (32) → runMigrations(31) → MIGRATIONS[32] runs. A typo in the migration
  // body would only surface here. *(Finding #7.)*
  it('the v32 migration recreates the table+index on an existing v31 DB', async () => {
    const db = await import('../database')
    await db.initializeDatabase()
    const dbi = db.getDatabase()

    // Simulate an existing v31 DB that predates this feature: no window table, version pinned to 31.
    dbi.run('DROP TABLE IF EXISTS recording_window_embeddings')
    dbi.run('DELETE FROM schema_version')
    dbi.run('INSERT INTO schema_version (version) VALUES (31)')
    db.saveDatabase() // persist the rewound image to the temp file (sql.js .run() does NOT auto-write)

    // Re-import + re-init forces the in-memory module to re-open the on-disk image and run Phase 3.
    vi.resetModules()
    const db2 = await import('../database')
    await db2.initializeDatabase()
    const dbi2 = db2.getDatabase()

    const tbl = dbi2.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='recording_window_embeddings'"
    )
    expect(tbl.length).toBe(1)
    const idx = dbi2.exec(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_rwe_recording_label'"
    )
    expect(idx.length).toBe(1)
    expect(db2.getDatabase().exec('SELECT MAX(version) FROM schema_version')[0].values[0][0]).toBe(32)
  })

  // Structural self-heal: an EXISTING v32 DB that somehow lost the table (corruption/restore) must
  // be repaired by the Phase-4 canonical-SCHEMA re-apply on the next boot — migrations are SKIPPED
  // here because currentVersion (32) === SCHEMA_VERSION (32), so this proves the table+index live in
  // the canonical SCHEMA and not ONLY in the migration. If the CREATE INDEX were misplaced into a
  // Phase-1-only path, this test would catch it. *(improvement-medium "structural-repair path".)*
  it('Phase 4 structural repair recreates the table+index on a current-version DB missing it', async () => {
    const db = await import('../database')
    await db.initializeDatabase()
    const dbi = db.getDatabase()
    expect(dbi.exec('SELECT MAX(version) FROM schema_version')[0].values[0][0]).toBe(32)

    // Drop the table but leave the version at 32 (no migration will run on re-init).
    dbi.run('DROP TABLE IF EXISTS recording_window_embeddings')
    db.saveDatabase() // persist the drop to the temp file before re-opening

    vi.resetModules()
    const db2 = await import('../database')
    await db2.initializeDatabase()
    const dbi2 = db2.getDatabase()

    const tbl = dbi2.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='recording_window_embeddings'"
    )
    expect(tbl.length).toBe(1)
    const idx = dbi2.exec(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_rwe_recording_label'"
    )
    expect(idx.length).toBe(1)
  })
})
