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

// Helper shared by both describes: pre-create the HiDock/data directory so sql.js saveDatabase() can write.
function setupTmpDir(dir: string) {
  mkdirSync(join(dir, 'HiDock', 'data'), { recursive: true })
}

describe('recording_window_embeddings schema (v32)', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rwe-schema-'))
    // DEFAULT_CONFIG.storage.dataPath = join(app.getPath('home'), 'HiDock') = tmpDir/HiDock
    // getDatabasePath() = tmpDir/HiDock/data/hidock.db — pre-create so saveDatabase() can write
    setupTmpDir(tmpDir)
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
    expect(ver[0].values[0][0]).toBe(33)
  })

  // The fresh-init test above takes the `currentVersion === 0` branch (database.ts:1948-1949),
  // which inserts SCHEMA_VERSION directly and gets the table from the canonical SCHEMA — it NEVER
  // executes MIGRATIONS[32]. This test forces the migration path: init once, then rewind the
  // schema_version row to 31 AND drop the table, then re-run initializeDatabase so currentVersion
  // (31) < SCHEMA_VERSION (33) → runMigrations(31) → MIGRATIONS[32] + MIGRATIONS[33] run. A typo in the migration
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
    expect(db2.getDatabase().exec('SELECT MAX(version) FROM schema_version')[0].values[0][0]).toBe(33)
  })

  // Structural self-heal: an EXISTING v32 DB that somehow lost the table (corruption/restore) must
  // be repaired by the Phase-4 canonical-SCHEMA re-apply on the next boot — migrations are SKIPPED
  // here because currentVersion (33) === SCHEMA_VERSION (33), so this proves the table+index live in
  // the canonical SCHEMA and not ONLY in the migration. If the CREATE INDEX were misplaced into a
  // Phase-1-only path, this test would catch it. *(improvement-medium "structural-repair path".)*
  it('Phase 4 structural repair recreates the table+index on a current-version DB missing it', async () => {
    const db = await import('../database')
    await db.initializeDatabase()
    const dbi = db.getDatabase()
    expect(dbi.exec('SELECT MAX(version) FROM schema_version')[0].values[0][0]).toBe(33)

    // Drop the table but leave the version at 33 (no migration will run on re-init).
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

describe('window-embedding accessors', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rwe-acc-'))
    setupTmpDir(tmpDir)
    vi.resetModules()
  })
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  const blob = (vals: number[]) => {
    const f32 = Float32Array.from(vals)
    return new Uint8Array(f32.buffer.slice(0))
  }

  it('batch insert round-trips grouped by label, ordered by window_index', async () => {
    const db = await import('../database')
    await db.initializeDatabase()
    db.insertWindowEmbeddingsBatch([
      { id: 'rwe_rec1_A_1', recording_id: 'rec1', file_label: 'A', window_index: 1,
        fingerprint: 'fpA', model_id: 'm', model_version: 1, dim: 2, embedding: blob([0.1, 0.2]) },
      { id: 'rwe_rec1_A_0', recording_id: 'rec1', file_label: 'A', window_index: 0,
        fingerprint: 'fpA', model_id: 'm', model_version: 1, dim: 2, embedding: blob([0.3, 0.4]) },
      { id: 'rwe_rec1_B_0', recording_id: 'rec1', file_label: 'B', window_index: 0,
        fingerprint: 'fpB', model_id: 'm', model_version: 1, dim: 2, embedding: blob([0.5, 0.6]) },
    ])
    const groups = db.getWindowEmbeddingsForRecording('rec1', 'm', 1)
    const a = groups.find((g) => g.fileLabel === 'A')!
    expect(a.fingerprint).toBe('fpA')
    expect(a.embeddings.length).toBe(2)
    // window_index 0 first
    expect(new Float32Array(a.embeddings[0].buffer.slice(0))[0]).toBeCloseTo(0.3)
    expect(new Float32Array(a.embeddings[1].buffer.slice(0))[0]).toBeCloseTo(0.1)
    expect(groups.find((g) => g.fileLabel === 'B')!.fingerprint).toBe('fpB')
  })

  it('getWindowEmbeddingsForRecording filters stale model_id / model_version', async () => {
    const db = await import('../database')
    await db.initializeDatabase()
    db.insertWindowEmbeddingsBatch([
      { id: 'rwe_x_A_0', recording_id: 'recX', file_label: 'A', window_index: 0,
        fingerprint: 'fp', model_id: 'good', model_version: 1, dim: 1, embedding: blob([1]) },
      { id: 'rwe_x_B_0', recording_id: 'recX', file_label: 'B', window_index: 0,
        fingerprint: 'fp', model_id: 'stale', model_version: 1, dim: 1, embedding: blob([1]) },
      { id: 'rwe_x_C_0', recording_id: 'recX', file_label: 'C', window_index: 0,
        fingerprint: 'fp', model_id: 'good', model_version: 9, dim: 1, embedding: blob([1]) },
    ])
    const groups = db.getWindowEmbeddingsForRecording('recX', 'good', 1)
    expect(groups.map((g) => g.fileLabel)).toEqual(['A'])
  })

  it('deleteWindowEmbeddingsForLabel removes only that label', async () => {
    const db = await import('../database')
    await db.initializeDatabase()
    db.insertWindowEmbeddingsBatch([
      { id: 'rwe_d_A_0', recording_id: 'recD', file_label: 'A', window_index: 0,
        fingerprint: 'fp', model_id: 'm', model_version: 1, dim: 1, embedding: blob([1]) },
      { id: 'rwe_d_B_0', recording_id: 'recD', file_label: 'B', window_index: 0,
        fingerprint: 'fp', model_id: 'm', model_version: 1, dim: 1, embedding: blob([1]) },
    ])
    db.deleteWindowEmbeddingsForLabel('recD', 'A')
    expect(db.getWindowEmbeddingsForRecording('recD', 'm', 1).map((g) => g.fileLabel)).toEqual(['B'])
  })

  it('deleteWindowEmbeddingsForRecording removes all rows for the recording', async () => {
    const db = await import('../database')
    await db.initializeDatabase()
    db.insertWindowEmbeddingsBatch([
      { id: 'rwe_r_A_0', recording_id: 'recR', file_label: 'A', window_index: 0,
        fingerprint: 'fp', model_id: 'm', model_version: 1, dim: 1, embedding: blob([1]) },
    ])
    db.deleteWindowEmbeddingsForRecording('recR')
    expect(db.getWindowEmbeddingsForRecording('recR', 'm', 1)).toEqual([])
  })

  it('empty batch is a no-op (does not throw)', async () => {
    const db = await import('../database')
    await db.initializeDatabase()
    expect(() => db.insertWindowEmbeddingsBatch([])).not.toThrow()
  })

  it('replaceWindowEmbeddingsForLabel atomically swaps a label\'s rows in one transaction', async () => {
    const db = await import('../database')
    await db.initializeDatabase()
    // Seed label A under the OLD fingerprint (2 windows) and label B (untouched).
    db.insertWindowEmbeddingsBatch([
      { id: 'rwe_rp_A_0', recording_id: 'recP', file_label: 'A', window_index: 0,
        fingerprint: 'OLD', model_id: 'm', model_version: 1, dim: 1, embedding: blob([1]) },
      { id: 'rwe_rp_A_1', recording_id: 'recP', file_label: 'A', window_index: 1,
        fingerprint: 'OLD', model_id: 'm', model_version: 1, dim: 1, embedding: blob([2]) },
      { id: 'rwe_rp_B_0', recording_id: 'recP', file_label: 'B', window_index: 0,
        fingerprint: 'OLD', model_id: 'm', model_version: 1, dim: 1, embedding: blob([9]) },
    ])
    // Replace A with a single fresh window under a NEW fingerprint.
    db.replaceWindowEmbeddingsForLabel('recP', 'A', [
      { id: 'rwe_rp_A_0', recording_id: 'recP', file_label: 'A', window_index: 0,
        fingerprint: 'NEW', model_id: 'm', model_version: 1, dim: 1, embedding: blob([7]) },
    ])
    const groups = db.getWindowEmbeddingsForRecording('recP', 'm', 1)
    const a = groups.find((g) => g.fileLabel === 'A')!
    expect(a.fingerprint).toBe('NEW')
    expect(a.embeddings.length).toBe(1) // old 2 rows gone, 1 fresh row present
    expect(new Float32Array(a.embeddings[0].buffer.slice(0))[0]).toBeCloseTo(7)
    // Label B is untouched.
    expect(groups.find((g) => g.fileLabel === 'B')!.embeddings.length).toBe(1)
  })

  it('replaceWindowEmbeddingsForLabel with empty rows just deletes the label', async () => {
    const db = await import('../database')
    await db.initializeDatabase()
    db.insertWindowEmbeddingsBatch([
      { id: 'rwe_re_A_0', recording_id: 'recE', file_label: 'A', window_index: 0,
        fingerprint: 'fp', model_id: 'm', model_version: 1, dim: 1, embedding: blob([1]) },
    ])
    db.replaceWindowEmbeddingsForLabel('recE', 'A', [])
    expect(db.getWindowEmbeddingsForRecording('recE', 'm', 1)).toEqual([])
  })

  // The headline guarantee: what insertWindowEmbeddingsBatch writes is byte-exact readable by
  // getWindowEmbeddingsForRecording AFTER a simulated restart (vi.resetModules re-imports the
  // module, dropping the in-process DB handle and forcing a re-open from the temp-dir image), and
  // a fingerprint recomputed "in session 2" matches the one persisted "in session 1". If this
  // round-trip ever drifted, every restart would be a silent cache miss and the feature would do
  // nothing — yet the mocked unit tests would still pass. *(improvement-high "restart-survival".)*
  it('persisted window rows survive a simulated restart and round-trip bit-exact', async () => {
    const vec = Float32Array.from([0.125, -0.5, 0.75, 1.0])
    // Session 1: init, write.
    {
      const db = await import('../database')
      await db.initializeDatabase()
      db.insertWindowEmbeddingsBatch([
        { id: 'rwe_surv_A_0', recording_id: 'recSurv', file_label: 'A', window_index: 0,
          fingerprint: 'fp-session1', model_id: 'm', model_version: 1, dim: vec.length,
          embedding: new Uint8Array(vec.buffer.slice(0)) },
      ])
    }
    // Session 2: drop module cache (re-open the on-disk image), read back.
    vi.resetModules()
    {
      const db = await import('../database')
      await db.initializeDatabase()
      const groups = db.getWindowEmbeddingsForRecording('recSurv', 'm', 1)
      const a = groups.find((g) => g.fileLabel === 'A')!
      expect(a.fingerprint).toBe('fp-session1')
      const readBack = new Float32Array(a.embeddings[0].buffer.slice(0))
      expect(Array.from(readBack)).toEqual(Array.from(vec)) // bit-exact
    }
  })
})
