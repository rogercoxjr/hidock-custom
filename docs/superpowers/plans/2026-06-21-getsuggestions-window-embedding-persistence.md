# Persist Mixed-Detection Window Embeddings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make `speakers:getSuggestions` pay the per-window ERes2Net embedding cost once ever (persisted to SQLite), so every later open — same session or after restart — is a sub-second DB read instead of a 30–60 s decode + inference.

**Architecture:** A new `recording_window_embeddings` table stores per-label, per-window embeddings keyed by a per-label content fingerprint (hash of the label's turns + slicing params + model). `speaker-matcher.ts` replaces its in-memory `WINDOW_EMB_CACHE` with a DB-backed read-or-recompute path: labels whose stored fingerprint matches the current one are read from DB (a zero-window label persists a tombstone so it is never re-decoded); misses trigger a single decode + re-embed of only the missing labels, persisted atomically via `replaceWindowEmbeddingsForLabel` (delete-then-insert in ONE transaction, one save). A per-recording single-flight promise map wraps the whole `embedRecordingLabels + runMatcher` sequence so overlapping IPC calls can't double-compute, and is evicted by mutation handlers after their deletes. Paired deletes keep window rows in sync with turn edits, merges, both re-transcribe sites, stale-model cleanup, and both soft-delete recording paths. The model version is single-sourced as `VOICEPRINT_MODEL_VERSION`.

**Tech Stack:** TypeScript (Electron main process), sql.js (SQLite/WASM, whole-image save on write, FK enforcement OFF), vitest, sherpa-onnx-node (ERes2Net, off-thread via utilityProcess).

## Global Constraints
- TypeScript, 120-column max line length.
- Tests are vitest; run a single file with: `cd apps/electron && npx vitest run <relative-path>`.
- Quality gates: `cd apps/electron && npm run typecheck && npm run lint && npm run test:run`.
- sql.js DB: the whole DB image is serialized + written to disk on every `run()`/`saveDatabase()`; never per-row `run()` in a hot loop — batch in ONE transaction and save once.
- FK enforcement is OFF globally (`database.ts:1720`); `ON DELETE CASCADE` is inert — deletes must be explicit/paired.
- The cache key is a per-label CONTENT FINGERPRINT (hash of the label's sorted turns + slicing params + model), NOT `diarization_run_id`.
- USB safety: do NOT touch device/USB code.
- New table goes in BOTH the canonical `SCHEMA` constant (Phase-1/Phase-4) AND the v32 migration; migration is additive only (no FK rebuild, no CHECK changes).
- Compute failure → nothing committed (atomic); never persist a partial label set as a hit. A recompute's delete-then-insert for a label MUST be ONE transaction (use `replaceWindowEmbeddingsForLabel`, never a separate delete + batch-insert which would be two auto-saving transactions).
- The model version is declared ONCE as `VOICEPRINT_MODEL_VERSION` in `voiceprint-service.ts`; the fingerprint, the DB-filter argument, and the inserted rows all reference it (no inline `1` literals).
- Window embeddings are voiceprint-invariant: adding/disabling a voiceprint must NOT invalidate windows (only scoring re-runs).

---

### Task 1: v32 schema migration + canonical-schema table/index

**Files:**
- Modify `apps/electron/electron/main/services/database.ts:11` (bump `SCHEMA_VERSION`)
- Modify `apps/electron/electron/main/services/database.ts:296` area (canonical `SCHEMA` — add table + index after `recording_label_embeddings`)
- Modify `apps/electron/electron/main/services/database.ts` MIGRATIONS object (add `32:` migration before the closing `}` near line 1791)
- Test: `apps/electron/electron/main/services/__tests__/window-embeddings-db.test.ts` (new)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a `recording_window_embeddings` table present on both fresh DBs and migrated DBs, with index `idx_rwe_recording_label`. `SCHEMA_VERSION === 32`.

Table shape (authoritative, from spec §1):
```sql
CREATE TABLE IF NOT EXISTS recording_window_embeddings (
  id                 TEXT PRIMARY KEY,
  recording_id       TEXT NOT NULL,
  transcript_id      TEXT,
  diarization_run_id TEXT,
  file_label         TEXT NOT NULL,
  window_index       INTEGER NOT NULL,
  fingerprint        TEXT NOT NULL,
  model_id           TEXT NOT NULL,
  model_version      INTEGER NOT NULL DEFAULT 1,
  dim                INTEGER NOT NULL,
  embedding          BLOB NOT NULL,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rwe_recording_label
  ON recording_window_embeddings(recording_id, file_label);
```

- [ ] **Step 1: Write the failing test.** Create `apps/electron/electron/main/services/__tests__/window-embeddings-db.test.ts`. This task's portion asserts the table + index exist after init and that the version is 32. The test boots the real database against a temp file by mocking `electron` `app.getPath('userData')` to a temp dir.

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
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
```

  Note: the second test persists the rewound v31 image to the same temp dir before `vi.resetModules()`, so the re-imported module re-opens it at v31 and the migration (not the canonical-schema path) supplies the table. If the canonical `CREATE INDEX` were placed where Phase 1 runs (CREATE TABLE only) instead of Phase 4, the FRESH test would still pass while a migrated DB lacked the index — this pair guards both paths.

- [ ] **Step 2: Run it, verify it fails.**
  `cd apps/electron && npx vitest run electron/main/services/__tests__/window-embeddings-db.test.ts`
  Expected: FAIL — `expect(tbl.length).toBe(1)` receives `0` (table absent) and/or version is `31` in both tests.

- [ ] **Step 3: Minimal implementation.**
  (a) `database.ts:11` — change `const SCHEMA_VERSION = 31` to `const SCHEMA_VERSION = 32`.
  (b) In the canonical `SCHEMA` template literal, immediately after the `recording_label_embeddings` `CREATE TABLE ... );` block (ends at `database.ts:312`), insert:
```sql

-- Per-recording per-label per-window embeddings for mixed-detection persistence (spec 2026-06-21, v32)
CREATE TABLE IF NOT EXISTS recording_window_embeddings (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL,
    transcript_id TEXT,
    diarization_run_id TEXT,
    file_label TEXT NOT NULL,
    window_index INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    model_id TEXT NOT NULL,
    model_version INTEGER NOT NULL DEFAULT 1,
    dim INTEGER NOT NULL,
    embedding BLOB NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rwe_recording_label ON recording_window_embeddings(recording_id, file_label);
```
  (Indexes in the canonical SCHEMA are applied in Phase 4 — see `database.ts:1957-1969` — so placing the `CREATE INDEX` here is correct; Phase 1 runs only `CREATE TABLE` statements.)
  Index rationale (deliberate, not an oversight): the single `idx_rwe_recording_label(recording_id, file_label)` covers the read `WHERE recording_id = ? AND model_id = ? AND model_version = ? ORDER BY file_label, window_index` on its leading `recording_id` prefix, and covers both delete paths (`...WHERE recording_id = ?` and `...recording_id = ? AND file_label = ?`). A `model_id`/`model_version` index is intentionally NOT added: those predicates are low-cardinality after the per-recording filter, and sql.js holds the whole DB in memory so the residual scan within one recording's rows (a handful of labels × ~6 windows) is trivially small. Not extending the index to `window_index` either — the in-memory sort over a few rows is free. *(improvement-low "index coverage".)*
  (c) Add a `32:` migration to the `MIGRATIONS` object (the object closes at `database.ts:1791-1793`; add a comma after migration `31`'s closing brace and insert):
```typescript
  ,

  32: () => {
    // v32: persist mixed-detection per-window embeddings (spec 2026-06-21). Additive
    // only — new table + index, no FK rebuild, no CHECK changes. Idempotent CREATEs so
    // a fresh DB (already created by the canonical SCHEMA) and an upgraded DB converge.
    console.log('Running migration to schema v32: recording_window_embeddings')
    const database = getDatabase()
    database.run(`CREATE TABLE IF NOT EXISTS recording_window_embeddings (
      id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, transcript_id TEXT, diarization_run_id TEXT,
      file_label TEXT NOT NULL, window_index INTEGER NOT NULL, fingerprint TEXT NOT NULL,
      model_id TEXT NOT NULL, model_version INTEGER NOT NULL DEFAULT 1, dim INTEGER NOT NULL,
      embedding BLOB NOT NULL, created_at TEXT NOT NULL)`)
    database.run(`CREATE INDEX IF NOT EXISTS idx_rwe_recording_label
      ON recording_window_embeddings(recording_id, file_label)`)
    console.log('Migration v32 complete')
  }
```

- [ ] **Step 4: Run tests, verify pass.**
  `cd apps/electron && npx vitest run electron/main/services/__tests__/window-embeddings-db.test.ts`
  Expected: PASS (3 tests passing — fresh-schema + v32 migration + Phase-4 structural repair).

- [ ] **Step 5: Commit.**
  `cd apps/electron && git add electron/main/services/database.ts electron/main/services/__tests__/window-embeddings-db.test.ts && git commit -m "feat(electron): v32 recording_window_embeddings table + migration"`

---

### Task 2: DB accessors — batch insert / grouped get / deletes

**Files:**
- Modify `apps/electron/electron/main/services/database.ts` (add interface + 4 functions after `deleteLabelEmbeddingsForRecording` at `database.ts:3288`)
- Test: `apps/electron/electron/main/services/__tests__/window-embeddings-db.test.ts` (extend the file from Task 1)

**Interfaces:**
- Consumes: `runInTransaction`, `runNoSave` (file-internal), `getDatabase`, `queryAll`, `saveDatabase` (all in `database.ts`).
- Produces (exact signatures later tasks rely on):
  - `export interface WindowEmbeddingRow { id: string; recording_id: string; transcript_id?: string | null; diarization_run_id?: string | null; file_label: string; window_index: number; fingerprint: string; model_id: string; model_version?: number; dim: number; embedding: Uint8Array; created_at?: string }`
  - `export function insertWindowEmbeddingsBatch(rows: WindowEmbeddingRow[]): void`
  - `export function replaceWindowEmbeddingsForLabel(recordingId: string, fileLabel: string, rows: WindowEmbeddingRow[]): void` — delete-then-insert for one label inside ONE transaction (one save). This is the accessor `getWindowEmbeddings` calls on recompute; it is the ONLY way the spec's "one transaction, never a partial label set" guarantee actually holds (a separate `deleteWindowEmbeddingsForLabel` + `insertWindowEmbeddingsBatch` would be two auto-saving transactions). *(Findings #4; improvement-high #1.)*
  - `export interface WindowEmbeddingGroup { fileLabel: string; fingerprint: string; embeddings: Uint8Array[] }`
  - `export function getWindowEmbeddingsForRecording(recordingId: string, modelId: string, modelVersion: number): WindowEmbeddingGroup[]`
  - `export function deleteWindowEmbeddingsForRecording(recordingId: string): void`
  - `export function deleteWindowEmbeddingsForLabel(recordingId: string, fileLabel: string): void`

- [ ] **Step 1: Write the failing test.** Append to `window-embeddings-db.test.ts` (inside the same file, reuse the `electron` mock + temp-dir setup). Add a second `describe`.

```typescript
describe('window-embedding accessors', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rwe-acc-'))
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

  it('replaceWindowEmbeddingsForLabel atomically swaps a label’s rows in one transaction', async () => {
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
```

- [ ] **Step 2: Run it, verify it fails.**
  `cd apps/electron && npx vitest run electron/main/services/__tests__/window-embeddings-db.test.ts`
  Expected: FAIL — `db.insertWindowEmbeddingsBatch is not a function`.

- [ ] **Step 3: Minimal implementation.** Insert after `deleteLabelEmbeddingsForRecording` (`database.ts:3288`):

```typescript
// v32 mixed-detection window embeddings (spec 2026-06-21 §2). The fingerprint is the
// content cache key (NOT diarization_run_id); see speaker-matcher.labelTurnsFingerprint.
export interface WindowEmbeddingRow {
  id: string; recording_id: string; transcript_id?: string | null; diarization_run_id?: string | null
  file_label: string; window_index: number; fingerprint: string
  model_id: string; model_version?: number; dim: number; embedding: Uint8Array; created_at?: string
}

export interface WindowEmbeddingGroup {
  fileLabel: string; fingerprint: string; embeddings: Uint8Array[]
}

/** Insert all window-embedding rows inside ONE transaction and save the sql.js image
 *  ONCE. Never per-row run() (whole-DB write storm). Empty input is a no-op. */
export function insertWindowEmbeddingsBatch(rows: WindowEmbeddingRow[]): void {
  if (rows.length === 0) return
  const now = new Date().toISOString()
  runInTransaction(() => {
    const stmt = getDatabase().prepare(`INSERT OR REPLACE INTO recording_window_embeddings
      (id, recording_id, transcript_id, diarization_run_id, file_label, window_index, fingerprint,
       model_id, model_version, dim, embedding, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    try {
      for (const r of rows) {
        stmt.bind([
          r.id, r.recording_id, r.transcript_id ?? null, r.diarization_run_id ?? null,
          r.file_label, r.window_index, r.fingerprint, r.model_id, r.model_version ?? 1,
          r.dim, r.embedding, r.created_at ?? now
        ])
        stmt.step()
        stmt.reset()
      }
    } finally {
      stmt.free()
    }
  })
}

/** Rows for a recording, grouped by file_label, embeddings ordered by window_index,
 *  with each label's fingerprint. Stale model_id / model_version rows are excluded. */
export function getWindowEmbeddingsForRecording(
  recordingId: string,
  modelId: string,
  modelVersion: number
): WindowEmbeddingGroup[] {
  const rows = queryAll<WindowEmbeddingRow>(
    `SELECT * FROM recording_window_embeddings
     WHERE recording_id = ? AND model_id = ? AND model_version = ?
     ORDER BY file_label, window_index`,
    [recordingId, modelId, modelVersion]
  )
  const byLabel = new Map<string, WindowEmbeddingGroup>()
  for (const r of rows) {
    let g = byLabel.get(r.file_label)
    if (!g) {
      g = { fileLabel: r.file_label, fingerprint: r.fingerprint, embeddings: [] }
      byLabel.set(r.file_label, g)
    }
    g.embeddings.push(r.embedding)
  }
  return [...byLabel.values()]
}

export function deleteWindowEmbeddingsForRecording(recordingId: string): void {
  run('DELETE FROM recording_window_embeddings WHERE recording_id = ?', [recordingId])
}

export function deleteWindowEmbeddingsForLabel(recordingId: string, fileLabel: string): void {
  run('DELETE FROM recording_window_embeddings WHERE recording_id = ? AND file_label = ?', [recordingId, fileLabel])
}

/** Atomically replace one label's window rows: DELETE the label's existing rows + INSERT the
 *  fresh set inside ONE transaction, saving the sql.js image ONCE. This is the recompute accessor
 *  the matcher uses — a separate delete + batch-insert would be TWO auto-saving transactions with a
 *  crash window that could leave the label with zero rows (spec §4.4 atomicity). Empty `rows` just
 *  deletes the label. */
export function replaceWindowEmbeddingsForLabel(
  recordingId: string,
  fileLabel: string,
  rows: WindowEmbeddingRow[]
): void {
  const now = new Date().toISOString()
  runInTransaction(() => {
    runNoSave('DELETE FROM recording_window_embeddings WHERE recording_id = ? AND file_label = ?', [
      recordingId,
      fileLabel,
    ])
    if (rows.length === 0) return
    const stmt = getDatabase().prepare(`INSERT OR REPLACE INTO recording_window_embeddings
      (id, recording_id, transcript_id, diarization_run_id, file_label, window_index, fingerprint,
       model_id, model_version, dim, embedding, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    try {
      for (const r of rows) {
        stmt.bind([
          r.id, r.recording_id, r.transcript_id ?? null, r.diarization_run_id ?? null,
          r.file_label, r.window_index, r.fingerprint, r.model_id, r.model_version ?? 1,
          r.dim, r.embedding, r.created_at ?? now
        ])
        stmt.step()
        stmt.reset()
      }
    } finally {
      stmt.free()
    }
  })
}
```
  Note: `runNoSave` is the file-internal non-saving runner (`database.ts:2107`); inside `runInTransaction` it participates in the single `BEGIN/COMMIT` + one `saveDatabase()`. Do NOT use the public `run()` here — it would auto-save mid-transaction.

- [ ] **Step 4: Run tests, verify pass.**
  `cd apps/electron && npx vitest run electron/main/services/__tests__/window-embeddings-db.test.ts`
  Expected: PASS (11 tests: 3 from Task 1 [fresh-schema + v32 migration + Phase-4 repair] + 8 here [5 accessor round-trips + 2 replaceWindowEmbeddingsForLabel + 1 restart-survival]).

- [ ] **Step 5: Commit.**
  `cd apps/electron && git add electron/main/services/database.ts electron/main/services/__tests__/window-embeddings-db.test.ts && git commit -m "feat(electron): DB accessors for recording_window_embeddings (batch insert, grouped get, deletes)"`

---

### Task 3: Per-label content fingerprint helper + single model-version constant

**Files:**
- Modify `apps/electron/electron/main/services/voiceprint-service.ts` (export `VOICEPRINT_MODEL_VERSION = 1` as the single source of truth for the model version)
- Modify `apps/electron/electron/main/services/voiceprint/speaker-matcher.ts` (add `labelTurnsFingerprint` + a slicing-params constant export)
- Test: `apps/electron/electron/main/services/voiceprint/__tests__/label-fingerprint.test.ts` (new)

**Interfaces:**
- Consumes: `VOICEPRINT_MODEL_ID`, `MAX_EMBED_SPEECH_MS` from `voiceprint-service.ts`; `Turn` from `asr/asr-provider`.
- Produces (later tasks rely on):
  - `export const VOICEPRINT_MODEL_VERSION = 1` (in `voiceprint-service.ts`) — the ONE place the model version is declared. The existing `model_version: 1` literal in `embedRecordingLabels` and the `e.model_version !== 1` staleness check (`voiceprint-service.ts:476`) should reference this constant so a future model bump is a one-line change. The DB-filter argument and the fingerprint's `modelVersion` (Task 4) both import it — no per-call literal. *(improvement-medium "WINDOW_MODEL_VERSION duplicated".)*
  - `export const WINDOW_SLICE_PARAMS = { windowMs: 20_000, hopMs: 10_000 } as const` (in `speaker-matcher.ts`)
  - `export function labelTurnsFingerprint(turns: Turn[], label: string, modelId: string, modelVersion: number): string`

Note: `MAX_EMBED_SPEECH_MS` is exported from `voiceprint-service.ts:135`. `sliceLabelWindows` (`voiceprint-service.ts:230`) defaults `windowMs=20_000`, `hopMs=10_000` and caps total samples at `MAX_EMBED_SPEECH_MS`; `WINDOW_SLICE_PARAMS` must mirror those defaults exactly so the fingerprint tracks the real slicing.

- [ ] **Step 1: Write the failing test.** Create `apps/electron/electron/main/services/voiceprint/__tests__/label-fingerprint.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/fake', getAppPath: () => '/fake/app', isPackaged: false },
}))

import { labelTurnsFingerprint, WINDOW_SLICE_PARAMS } from '../speaker-matcher'
import type { Turn } from '../../asr/asr-provider'

const turn = (speaker: string, startMs: number, endMs: number): Turn => ({
  speaker, startMs, endMs, text: 'x',
})

describe('labelTurnsFingerprint', () => {
  it('is stable across call order and ignores other labels', () => {
    const t1: Turn[] = [turn('A', 0, 1000), turn('B', 1000, 2000), turn('A', 3000, 4000)]
    const t2: Turn[] = [turn('A', 3000, 4000), turn('B', 9000, 9999), turn('A', 0, 1000)]
    expect(labelTurnsFingerprint(t1, 'A', 'm', 1)).toBe(labelTurnsFingerprint(t2, 'A', 'm', 1))
  })

  it('changes when the label gains/loses a turn (per-turn reassign)', () => {
    const before: Turn[] = [turn('A', 0, 1000), turn('B', 1000, 2000)]
    const after: Turn[] = [turn('A', 0, 1000), turn('A', 1000, 2000)] // B's turn reassigned to A
    expect(labelTurnsFingerprint(before, 'A', 'm', 1)).not.toBe(labelTurnsFingerprint(after, 'A', 'm', 1))
  })

  it('changes when model id or version changes', () => {
    const t: Turn[] = [turn('A', 0, 1000)]
    expect(labelTurnsFingerprint(t, 'A', 'm', 1)).not.toBe(labelTurnsFingerprint(t, 'A', 'm2', 1))
    expect(labelTurnsFingerprint(t, 'A', 'm', 1)).not.toBe(labelTurnsFingerprint(t, 'A', 'm', 2))
  })

  it('exposes the slicing params that match sliceLabelWindows defaults', () => {
    expect(WINDOW_SLICE_PARAMS).toEqual({ windowMs: 20_000, hopMs: 10_000 })
  })
})

describe('VOICEPRINT_MODEL_VERSION', () => {
  it('is the single declared model version (1)', async () => {
    const vp = await import('../../voiceprint-service')
    expect(vp.VOICEPRINT_MODEL_VERSION).toBe(1)
  })
})
```

- [ ] **Step 2: Run it, verify it fails.**
  `cd apps/electron && npx vitest run electron/main/services/voiceprint/__tests__/label-fingerprint.test.ts`
  Expected: FAIL — `labelTurnsFingerprint`/`WINDOW_SLICE_PARAMS` is not exported.

- [ ] **Step 3: Minimal implementation.**
  (a0) In `voiceprint-service.ts`, immediately after the `MAX_EMBED_SPEECH_MS` export (`voiceprint-service.ts:135`), add the single model-version constant:
```typescript
/** The active voiceprint/window-embedding model version — the ONE place this is declared.
 *  Bump here (and only here) when the model changes; all stale-filters/fingerprints key off it. */
export const VOICEPRINT_MODEL_VERSION = 1
```
  Then replace the inline `1` literals already in this file with the constant: in `embedRecordingLabels` the staleness check `e.model_version !== 1` (`voiceprint-service.ts:476`) becomes `e.model_version !== VOICEPRINT_MODEL_VERSION`, and wherever a label-embedding row is written with `model_version: 1` use `model_version: VOICEPRINT_MODEL_VERSION`. (Grep `model_version` in this file; replace each literal `1` that means "the current model version".)

  Now in `speaker-matcher.ts`, add `createHash` to the `crypto` import and `MAX_EMBED_SPEECH_MS`/`Turn` imports, then add the helper.
  (a) At the top, after the existing imports (after line 37), add:
```typescript
import { createHash } from 'crypto'
import type { Turn } from '../asr/asr-provider'
```
  (b) Add `MAX_EMBED_SPEECH_MS` to the existing `voiceprint-service` import block (currently `speaker-matcher.ts` lines 20-25 import `decodeRecordingPcm16k, embedLabelWindows, MIN_CLEAN_SPEECH_MS, VOICEPRINT_MODEL_ID`):
```typescript
import {
  decodeRecordingPcm16k,
  embedLabelWindows,
  MAX_EMBED_SPEECH_MS,
  MIN_CLEAN_SPEECH_MS,
  VOICEPRINT_MODEL_ID,
} from '../voiceprint-service'
```
  (c) After the `MatcherResult` interface (after line 49), add:
```typescript
/** Window slicing params — MUST mirror sliceLabelWindows() defaults in voiceprint-service.ts
 *  (windowMs=20_000, hopMs=10_000). Folded into the fingerprint so a slicing change invalidates
 *  persisted windows. */
export const WINDOW_SLICE_PARAMS = { windowMs: 20_000, hopMs: 10_000 } as const

/**
 * Per-label content fingerprint — the cache key for persisted window embeddings.
 *
 * Hashes the label's sorted turn time-ranges + the slicing params + model id/version. It
 * changes exactly when the label's windows would differ: turn-membership edits (per-turn
 * reassign, merge), slicing-param changes, or model swaps. NOT keyed by diarization_run_id
 * (a per-turn reassign edits turn membership without minting a new run id).
 */
export function labelTurnsFingerprint(
  turns: Turn[],
  label: string,
  modelId: string,
  modelVersion: number
): string {
  const mine = turns
    .filter((t) => t.speaker === label)
    .map((t) => [t.startMs, t.endMs] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const payload = JSON.stringify([
    mine,
    { windowMs: WINDOW_SLICE_PARAMS.windowMs, hopMs: WINDOW_SLICE_PARAMS.hopMs, maxMs: MAX_EMBED_SPEECH_MS },
    modelId,
    modelVersion,
  ])
  return createHash('sha1').update(payload).digest('hex')
}
```

- [ ] **Step 4: Run tests, verify pass.**
  `cd apps/electron && npx vitest run electron/main/services/voiceprint/__tests__/label-fingerprint.test.ts`
  Expected: PASS (5 tests — 4 fingerprint + 1 VOICEPRINT_MODEL_VERSION).
  Also re-run the existing voiceprint-service suite to confirm the literal→constant swap didn't change behavior:
  `cd apps/electron && npx vitest run electron/main/services/__tests__/voiceprint-service.test.ts`
  Expected: PASS (no behavior change — `VOICEPRINT_MODEL_VERSION === 1`, identical to the old literal).

- [ ] **Step 5: Commit.**
  `cd apps/electron && git add electron/main/services/voiceprint-service.ts electron/main/services/voiceprint/speaker-matcher.ts electron/main/services/voiceprint/__tests__/label-fingerprint.test.ts && git commit -m "feat(electron): per-label content fingerprint helper + single VOICEPRINT_MODEL_VERSION constant"`

---

### Task 4: DB-backed `getWindowEmbeddings` (replace in-memory `WINDOW_EMB_CACHE`)

**Files:**
- Modify `apps/electron/electron/main/services/voiceprint/speaker-matcher.ts` (replace the cache + `getWindowEmbeddings`; update `runMatcher`'s call site; remove the `__clearWindowEmbeddingCache` import + `beforeEach` call in the test as part of THIS task so the file stays runnable)
- Modify `apps/electron/electron/main/services/voiceprint/__tests__/speaker-matcher.test.ts` (extend mocks; remove the now-dead `__clearWindowEmbeddingCache` import/call; the two perf tests are rewritten in Task 7)

**Interfaces:**
- Consumes: `labelTurnsFingerprint`, `WINDOW_SLICE_PARAMS` (Task 3); `VOICEPRINT_MODEL_VERSION` (Task 3, from `voiceprint-service`); `getWindowEmbeddingsForRecording(recordingId, modelId, modelVersion)`, `replaceWindowEmbeddingsForLabel(recordingId, fileLabel, rows)`, `WindowEmbeddingRow` (Task 2); `getTranscriptByRecordingId` (database); `decodeRecordingPcm16k`, `embedLabelWindows`, `blobToFloat32` for reads.
- Produces: a DB-backed `getWindowEmbeddings(recordingId, longLabels, diarizationRunId, turns)` returning `Promise<WindowedLabel[]>` where `WindowedLabel = { fileLabel: string; windowEmbs: Float32Array[] }` (from `mixed-detector`). The `diarizationRunId` and `turns` are passed in by `runMatcher` (already resolved/parsed there) so this function does not re-parse turns or re-query label embeddings; it makes a single cheap `getTranscriptByRecordingId` read only to stamp `transcript_id` on persisted rows. Removes exports `invalidateWindowEmbeddings` and `__clearWindowEmbeddingCache`.

Design (spec §4): for each long label compute its current fingerprint from the passed-in `turns`. Read persisted groups; a label hits iff a group exists AND its stored fingerprint equals the current one (including the **empty tombstone** case — see below). If all hit → return decoded Float32 windows, no decode/inference. If any miss → decode once, `embedLabelWindows` for missing labels only, then `replaceWindowEmbeddingsForLabel` (ONE transaction per label: delete the label's stale rows + insert the fresh set). Always return the full long-label set (hits + recomputed).

Empty-tombstone (improvement-medium "empty-windows label re-decodes every open"): a long label that legitimately yields zero windows (all turns too short, or the embed pass returned none) must NOT remain a permanent miss — otherwise every open re-decodes the whole 300–450 MB file for that recording. On a zero-window recompute, persist a single **sentinel row** (`window_index: -1`, `dim: 0`, `embedding: new Uint8Array(0)`) carrying the current fingerprint. On read, a group whose only row is a 0-byte sentinel and whose fingerprint matches is a **hit that contributes no windows** (mixed detection simply skips that label) — no decode. Only a genuine decode/worker FAILURE (pcm undefined / exception thrown) stays a retry-next-call (nothing persisted).

- [ ] **Step 1: Write the failing test.** First make the file runnable under the removed export, THEN add the new behavior tests.
  (i) Change the import at `speaker-matcher.test.ts:7` from `import { runMatcher, __clearWindowEmbeddingCache } from '../speaker-matcher'` to:
```typescript
import { runMatcher, labelTurnsFingerprint } from '../speaker-matcher'
```
  (ii) Delete the `__clearWindowEmbeddingCache()` line in `beforeEach` (`speaker-matcher.test.ts:68`). (Task 4 removes the export, so this MUST go now or every test in the file errors in `beforeEach` — finding #3. Task 7 only rewrites the two perf tests; it no longer touches the import/beforeEach.)
  (iii) Extend the `vi.mock('../../database', ...)` factory (currently `speaker-matcher.test.ts:13-23`) to add:
```typescript
  getTranscriptByRecordingId: vi.fn(),
  getWindowEmbeddingsForRecording: vi.fn(() => []),
  replaceWindowEmbeddingsForLabel: vi.fn(),
  deleteWindowEmbeddingsForRecording: vi.fn(),
```
  (iv) Add `MAX_EMBED_SPEECH_MS: 60_000,` and `VOICEPRINT_MODEL_VERSION: 1,` to the `vi.mock('../../voiceprint-service', ...)` factory (`speaker-matcher.test.ts:25-30`).
  (v) In `beforeEach`, add resets:
```typescript
  vi.mocked(db.getTranscriptByRecordingId).mockReset().mockReturnValue(undefined as never)
  vi.mocked(db.getWindowEmbeddingsForRecording).mockReset().mockReturnValue([] as never)
  vi.mocked(db.replaceWindowEmbeddingsForLabel).mockReset()
  vi.mocked(db.deleteWindowEmbeddingsForRecording).mockReset()
```
  (vi) Then add the new behavior describe (`labelTurnsFingerprint` is now imported at the top):

```typescript
describe('runMatcher() — DB-backed window embeddings', () => {
  const longRows = [
    {
      id: 'le_M', recording_id: 'rec_1', file_label: 'M', model_id: VOICEPRINT_MODEL_ID,
      dim: 256, embedding: embBlob(SAME_VEC), clean_speech_ms: 25_000, diarization_run_id: 'drun_1',
    },
  ] as never
  const turns = [
    { speaker: 'M', startMs: 0, endMs: 22_000, text: 'a' },
    { speaker: 'M', startMs: 22_000, endMs: 44_000, text: 'b' },
  ]

  it('first call computes + persists window embeddings via replaceWindowEmbeddingsForLabel', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue(longRows)
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([] as never)
    vi.mocked(db.getRecordingById).mockReturnValue({ id: 'rec_1', file_path: '/r/rec.wav' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({ id: 't1', turns: JSON.stringify(turns) } as never)
    vi.mocked(db.getWindowEmbeddingsForRecording).mockReturnValue([] as never) // DB empty → miss
    vi.mocked(vp.embedLabelWindows).mockResolvedValue([DIFF_VEC, SAME_VEC])

    await runMatcher('rec_1')

    expect(vi.mocked(vp.decodeRecordingPcm16k)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(vp.embedLabelWindows)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(db.replaceWindowEmbeddingsForLabel)).toHaveBeenCalledTimes(1)
    const [rid, lbl, inserted] = vi.mocked(db.replaceWindowEmbeddingsForLabel).mock.calls[0]
    expect(rid).toBe('rec_1')
    expect(lbl).toBe('M')
    expect(inserted.length).toBe(2) // two windows
    expect(inserted[0].window_index).toBe(0)
    expect(inserted[1].window_index).toBe(1)
    expect(inserted[0].diarization_run_id).toBe('drun_1') // run id passed through from runMatcher
    const fp = labelTurnsFingerprint(turns as never, 'M', VOICEPRINT_MODEL_ID, 1)
    expect(inserted[0].fingerprint).toBe(fp)
  })

  it('second call (DB hit, matching fingerprint) reads from DB, no decode/embed', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue(longRows)
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([] as never)
    vi.mocked(db.getRecordingById).mockReturnValue({ id: 'rec_1', file_path: '/r/rec.wav' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({ id: 't1', turns: JSON.stringify(turns) } as never)
    const fp = labelTurnsFingerprint(turns as never, 'M', VOICEPRINT_MODEL_ID, 1)
    vi.mocked(db.getWindowEmbeddingsForRecording).mockReturnValue([
      { fileLabel: 'M', fingerprint: fp, embeddings: [embBlob(DIFF_VEC), embBlob(SAME_VEC)] },
    ] as never)

    const { summary } = await runMatcher('rec_1')

    expect(vi.mocked(vp.decodeRecordingPcm16k)).not.toHaveBeenCalled()
    expect(vi.mocked(vp.embedLabelWindows)).not.toHaveBeenCalled()
    expect(vi.mocked(db.replaceWindowEmbeddingsForLabel)).not.toHaveBeenCalled()
    expect(summary.mixed).toBe(1) // scoring still re-runs and yields the mixed suggestion
  })

  it('stale fingerprint (edited turns) recomputes only that label and replaces its rows', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue(longRows)
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([] as never)
    vi.mocked(db.getRecordingById).mockReturnValue({ id: 'rec_1', file_path: '/r/rec.wav' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({ id: 't1', turns: JSON.stringify(turns) } as never)
    vi.mocked(db.getWindowEmbeddingsForRecording).mockReturnValue([
      { fileLabel: 'M', fingerprint: 'STALE_FINGERPRINT', embeddings: [embBlob(SAME_VEC)] },
    ] as never)
    vi.mocked(vp.embedLabelWindows).mockResolvedValue([DIFF_VEC, SAME_VEC])

    await runMatcher('rec_1')

    expect(vi.mocked(vp.embedLabelWindows)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(db.replaceWindowEmbeddingsForLabel)).toHaveBeenCalledWith(
      'rec_1', 'M', expect.arrayContaining([expect.objectContaining({ window_index: 0 })])
    )
  })

  it('zero-window label persists an empty tombstone and is a hit (no re-decode) next call', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue(longRows)
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([] as never)
    vi.mocked(db.getRecordingById).mockReturnValue({ id: 'rec_1', file_path: '/r/rec.wav' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({ id: 't1', turns: JSON.stringify(turns) } as never)
    // First call: DB empty, embed yields zero windows → tombstone persisted.
    vi.mocked(db.getWindowEmbeddingsForRecording).mockReturnValueOnce([] as never)
    vi.mocked(vp.embedLabelWindows).mockResolvedValueOnce([])

    await runMatcher('rec_1')

    expect(vi.mocked(db.replaceWindowEmbeddingsForLabel)).toHaveBeenCalledTimes(1)
    const [, , rows] = vi.mocked(db.replaceWindowEmbeddingsForLabel).mock.calls[0]
    expect(rows.length).toBe(1)
    expect(rows[0].window_index).toBe(-1) // sentinel
    expect(rows[0].dim).toBe(0)
    expect(rows[0].embedding.byteLength).toBe(0)

    // Second call: the tombstone (matching fingerprint, 0-byte blob) is a hit → no decode/embed.
    const fp = labelTurnsFingerprint(turns as never, 'M', VOICEPRINT_MODEL_ID, 1)
    vi.mocked(db.getWindowEmbeddingsForRecording).mockReturnValue([
      { fileLabel: 'M', fingerprint: fp, embeddings: [new Uint8Array(0)] },
    ] as never)
    vi.mocked(vp.decodeRecordingPcm16k).mockClear()
    vi.mocked(vp.embedLabelWindows).mockClear()

    await runMatcher('rec_1')

    expect(vi.mocked(vp.decodeRecordingPcm16k)).not.toHaveBeenCalled()
    expect(vi.mocked(vp.embedLabelWindows)).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it, verify it fails.**
  `cd apps/electron && npx vitest run electron/main/services/voiceprint/__tests__/speaker-matcher.test.ts -t "DB-backed window embeddings"`
  Expected: FAIL — old `getWindowEmbeddings` never calls `getWindowEmbeddingsForRecording`/`replaceWindowEmbeddingsForLabel`; assertions on those mocks fail. (The file now imports `labelTurnsFingerprint` and no longer references `__clearWindowEmbeddingCache`, so the file loads and `beforeEach` runs cleanly — only the new behavior assertions fail.)

- [ ] **Step 3: Minimal implementation.** In `speaker-matcher.ts`:
  (a) Add the new DB imports to the `database` import block (lines 9-19): `getTranscriptByRecordingId`, `getWindowEmbeddingsForRecording`, `replaceWindowEmbeddingsForLabel`, and the type `WindowEmbeddingRow`:
```typescript
import {
  deletePendingSuggestionsForRecording,
  getActiveVoiceprintsByContactId,
  getContactsWithActiveVoiceprints,
  getLabelEmbeddingsForRecording,
  getRecordingById,
  getRecordingSpeaker,
  getSelfContactId,
  getSuggestionsForRecording,
  getTranscriptByRecordingId,
  getWindowEmbeddingsForRecording,
  insertSuggestion,
  replaceWindowEmbeddingsForLabel,
  type WindowEmbeddingRow,
} from '../database'
```
  Also add `VOICEPRINT_MODEL_VERSION` to the `voiceprint-service` import block (the one edited in Task 3b):
```typescript
import {
  decodeRecordingPcm16k,
  embedLabelWindows,
  MAX_EMBED_SPEECH_MS,
  MIN_CLEAN_SPEECH_MS,
  VOICEPRINT_MODEL_ID,
  VOICEPRINT_MODEL_VERSION,
} from '../voiceprint-service'
```
  (b) Replace the entire in-memory cache block (`speaker-matcher.ts:51-137` — the comment, `WINDOW_EMB_CACHE`, `WINDOW_EMB_CACHE_MAX`, `windowCacheKey`, `invalidateWindowEmbeddings`, `__clearWindowEmbeddingCache`, and the old `getWindowEmbeddings`) with:

```typescript
/** Float32 embedding → little-endian byte BLOB (4 bytes/element). Copies (slice) so no
 *  external/zero-copy view escapes into the sql.js bind path. */
function windowEmbToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength))
}

/**
 * DB-backed per-window embeddings for the recording's long labels (spec §4).
 *
 * `turns` and `diarizationRunId` are passed in by the caller (runMatcher already parsed/resolved
 * them) so this function performs ZERO redundant DB reads beyond the single window-row read.
 *
 * Each long label's CURRENT content fingerprint is compared to the persisted one. Labels whose
 * fingerprint matches are served from DB (no decode/inference) — including the empty-tombstone
 * case (a single 0-byte sentinel row → a hit that contributes no windows). Any miss triggers ONE
 * decode of the file, re-embeds only the missing labels, and atomically replaces that label's rows
 * via `replaceWindowEmbeddingsForLabel`. A label that genuinely yields zero windows persists a
 * sentinel so it is not re-decoded on every open. Scoring against contacts always re-runs in the
 * caller, so results track the current voiceprint set.
 */
async function getWindowEmbeddings(
  recordingId: string,
  longLabels: string[],
  diarizationRunId: string | null,
  turns: Turn[]
): Promise<WindowedLabel[]> {
  if (longLabels.length === 0) return []

  const transcript = getTranscriptByRecordingId(recordingId)
  const transcriptId = transcript?.id ?? null

  // Current fingerprint per long label (computed from the passed-in turns — no re-read).
  const fpByLabel = new Map<string, string>()
  for (const label of longLabels) {
    fpByLabel.set(label, labelTurnsFingerprint(turns, label, VOICEPRINT_MODEL_ID, VOICEPRINT_MODEL_VERSION))
  }

  // Persisted (non-stale-model) groups, indexed by label.
  const persisted = new Map<string, { fingerprint: string; embeddings: Uint8Array[] }>()
  for (const g of getWindowEmbeddingsForRecording(recordingId, VOICEPRINT_MODEL_ID, VOICEPRINT_MODEL_VERSION)) {
    persisted.set(g.fileLabel, { fingerprint: g.fingerprint, embeddings: g.embeddings })
  }

  const result: WindowedLabel[] = []
  const misses: string[] = []
  for (const label of longLabels) {
    const hit = persisted.get(label)
    if (hit && hit.fingerprint === fpByLabel.get(label)) {
      // Empty tombstone: a single 0-byte sentinel blob → valid empty hit (no windows, no decode).
      const isTombstone = hit.embeddings.length === 1 && hit.embeddings[0].byteLength === 0
      if (isTombstone) {
        // contributes no windows; do NOT push to result, do NOT re-decode.
      } else if (hit.embeddings.length > 0) {
        result.push({ fileLabel: label, windowEmbs: hit.embeddings.map((b) => blobToFloat32(b)) })
      } else {
        misses.push(label)
      }
    } else {
      misses.push(label)
    }
  }

  if (misses.length === 0) return result

  // At least one miss → decode the file ONCE.
  let pcm: Buffer | undefined
  const recording = getRecordingById(recordingId)
  if (recording?.file_path) {
    try {
      pcm = await decodeRecordingPcm16k(recording.file_path)
    } catch (e) {
      console.warn(`[Voiceprint] runMatcher decode failed for ${recordingId}: ${(e as Error).message}`)
    }
  }
  if (!pcm) return result // hits (if any) still usable; misses retried next call (nothing persisted)

  for (const label of misses) {
    const fingerprint = fpByLabel.get(label)!
    try {
      const windowEmbs = await embedLabelWindows(recordingId, label, {
        pcm,
        windowMs: WINDOW_SLICE_PARAMS.windowMs,
        hopMs: WINDOW_SLICE_PARAMS.hopMs,
      })
      if (windowEmbs.length === 0) {
        // Legitimately zero windows → persist a tombstone so we never re-decode this recording
        // for this label/fingerprint again. (Decode succeeded; only the slice/embed produced none.)
        replaceWindowEmbeddingsForLabel(recordingId, label, [
          {
            id: `rwe_${recordingId}_${label}_tomb`,
            recording_id: recordingId,
            transcript_id: transcriptId,
            diarization_run_id: diarizationRunId,
            file_label: label,
            window_index: -1,
            fingerprint,
            model_id: VOICEPRINT_MODEL_ID,
            model_version: VOICEPRINT_MODEL_VERSION,
            dim: 0,
            embedding: new Uint8Array(0),
          },
        ])
        continue // mixed detection skips this label
      }
      const rows: WindowEmbeddingRow[] = windowEmbs.map((emb, i) => ({
        id: `rwe_${recordingId}_${label}_${i}`,
        recording_id: recordingId,
        transcript_id: transcriptId,
        diarization_run_id: diarizationRunId,
        file_label: label,
        window_index: i,
        fingerprint,
        model_id: VOICEPRINT_MODEL_ID,
        model_version: VOICEPRINT_MODEL_VERSION,
        dim: emb.length,
        embedding: windowEmbToBlob(emb),
      }))
      // Atomic replace: delete this label's stale rows + insert the fresh set in ONE transaction.
      replaceWindowEmbeddingsForLabel(recordingId, label, rows)
      result.push({ fileLabel: label, windowEmbs })
    } catch (e) {
      console.warn(
        `[Voiceprint] runMatcher mixed detection skipped for ${label} (${recordingId}): ${(e as Error).message}`
      )
    }
  }
  return result
}
```
  Note on the row `id`: `rwe_${recordingId}_${label}_${i}` is deterministic and combined with `INSERT OR REPLACE` lets a recompute overwrite same-index rows; `replaceWindowEmbeddingsForLabel` also DELETEs the label's rows first, so a label that shrinks (fewer windows) doesn't leave stragglers. Recording ids are uuid-like and labels are diarization labels (`SPEAKER_00`, or a merged/renamed string); the id is never parsed back, so a `_` inside a label is harmless. *(Low finding "id collides across fingerprints" — acknowledged; the (recording,label) DELETE-before-insert is what guarantees replacement, not the id, so no collision-driven correctness bug remains.)*

  (c) `runMatcher` must parse the recording's turns ONCE and pass them plus the already-resolved `diarizationRunId` to `getWindowEmbeddings`. Just before the call site (currently `speaker-matcher.ts:246`), add the turns parse, then change the call:
```typescript
    // Window/mixed detection needs the diarized turns; parse once and reuse (the fingerprint is
    // computed from them). diarizationRunId was already resolved in step b.
    const wTranscript = getTranscriptByRecordingId(recordingId)
    let wTurns: Turn[] = []
    try {
      wTurns = wTranscript?.turns ? (JSON.parse(wTranscript.turns) as Turn[]) : []
    } catch {
      wTurns = []
    }
    const windowed = await getWindowEmbeddings(recordingId, longLabels, diarizationRunId, wTurns)
```

  Note: `windowEmbToBlob` copies via `buffer.slice`; the persisted-row blobs returned by sql.js are decoded with `blobToFloat32` (which itself copies — `vector-math.ts:8`), so no zero-copy view escapes. (`getWindowEmbeddings` calls `getTranscriptByRecordingId` once for `transcript_id`; `runMatcher` calls it once for turns — two reads of the same small row total, both cheap. If you prefer zero duplication, pass `transcriptId` in too; left as-is for signature simplicity since the row is tiny and in-memory.)

- [ ] **Step 4: Run tests, verify pass.**
  First confirm the 4 new DB-backed tests pass in isolation:
  `cd apps/electron && npx vitest run electron/main/services/voiceprint/__tests__/speaker-matcher.test.ts -t "DB-backed window embeddings"`
  Expected: 4 passed (first-compute, DB-hit, stale-recompute, empty-tombstone).
  Then run the whole file:
  `cd apps/electron && npx vitest run electron/main/services/voiceprint/__tests__/speaker-matcher.test.ts`
  Expected: all the original identity/merge/mixed/privacy/idempotency tests PASS (the file now imports `labelTurnsFingerprint` and the `beforeEach` no longer calls `__clearWindowEmbeddingCache`, so the file loads cleanly) EXCEPT the two OLD perf tests (`perf: caches window embeddings per (recording, run)` and `perf: a new diarization run id re-decodes...`), which still reference the old in-memory behavior and will FAIL. That is expected — Task 7 rewrites exactly those two tests. The file does NOT error on load anymore (finding #3 resolved by moving the import/beforeEach fix into this task).

- [ ] **Step 5: Commit.**
  `cd apps/electron && git add electron/main/services/voiceprint/speaker-matcher.ts electron/main/services/voiceprint/__tests__/speaker-matcher.test.ts && git commit -m "feat(electron): DB-backed getWindowEmbeddings replaces in-memory WINDOW_EMB_CACHE"`

---

### Task 5: Single-flight wrapping the whole `embedRecordingLabels + runMatcher` sequence

**Files:**
- Modify `apps/electron/electron/main/ipc/speakers-handlers.ts` (add per-recording in-flight map; wrap the embed+match sequence in `speakers:getSuggestions`)
- Test: `apps/electron/electron/main/ipc/__tests__/speakers-getsuggestions-singleflight.test.ts` (new)

**Interfaces:**
- Consumes: `embedRecordingLabels(recordingId)`, `runMatcher(recordingId)` (existing).
- Produces: an internal `getSuggestionsSequence(recordingId): Promise<MatcherResult>` deduped per recordingId via a module-level `Map<string, Promise<MatcherResult>>` that clears on settle, plus `clearSuggestionsInFlight(recordingId): void` used by the mutation handlers (merge / updateTurns) to evict a stale in-flight compute after they delete embeddings. No exported signature change to the handler.

Design (spec §5): two overlapping `getSuggestions` for the same recording must run the expensive `embedRecordingLabels + runMatcher` ONCE. Key the in-flight promise by recordingId; both callers await the same promise; the entry is deleted on settle (success OR failure) so a later call re-computes. On a REJECTION both concurrent callers share the same rejected promise; the existing `speakers:getSuggestions` try/catch turns that into the `[]` result for each, and the map entry is cleared in `.finally` so a third (later) call re-invokes embed+match. Mutation handlers (merge, updateTurns) that delete embeddings call `clearSuggestionsInFlight(recordingId)` AFTER their deletes, so a `getSuggestions` already in flight when the edit lands is evicted and the renderer's post-edit refresh starts a fresh compute rather than adopting the pre-edit one. *(improvement-medium "single-flight caches rejections / edit-during-flight".)*

- [ ] **Step 1: Write the failing test.** Create `apps/electron/electron/main/ipc/__tests__/speakers-getsuggestions-singleflight.test.ts`. It captures the `speakers:getSuggestions` handler via a mocked `ipcMain.handle`, fires two calls concurrently, and asserts `embedRecordingLabels`/`runMatcher` each ran once.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: class {},
}))

const embedRecordingLabels = vi.fn(async () => {})
let resolveMatcher: (v: { diarizationRunId: string | null }) => void
const runMatcher = vi.fn(
  () => new Promise<{ diarizationRunId: string | null }>((res) => { resolveMatcher = res })
)

vi.mock('../../services/voiceprint-service', () => ({
  embedRecordingLabels: (...a: unknown[]) => embedRecordingLabels(...a),
}))
vi.mock('../../services/voiceprint/speaker-matcher', () => ({
  runMatcher: () => runMatcher(),
}))
vi.mock('../../services/database', () => ({
  upsertRecordingSpeaker: vi.fn(), deleteRecordingSpeaker: vi.fn(), getRecordingSpeaker: vi.fn(),
  getRecordingSpeakers: vi.fn(() => []), getContactById: vi.fn(), getTranscriptByRecordingId: vi.fn(),
  updateTranscriptTurns: vi.fn(), deleteVoiceprintsBySource: vi.fn(),
  getPendingSuggestions: vi.fn(() => []), getSelfContactId: vi.fn(),
  deleteLabelEmbeddingsForRecording: vi.fn(), deleteWindowEmbeddingsForRecording: vi.fn(),
  expireSuggestionsForRecording: vi.fn(), acceptSuggestion: vi.fn(), dismissSuggestion: vi.fn(),
}))

describe('speakers:getSuggestions single-flight', () => {
  beforeEach(async () => {
    handlers.clear()
    embedRecordingLabels.mockClear()
    runMatcher.mockClear()
    const mod = await import('../speakers-handlers')
    mod.registerSpeakersHandlers()
  })

  it('two overlapping calls for the same recording run embed+match once', async () => {
    const handler = handlers.get('speakers:getSuggestions')!
    const p1 = handler({}, 'rec_X')
    const p2 = handler({}, 'rec_X')
    // Let the first call reach the pending runMatcher promise.
    await new Promise((r) => setImmediate(r))
    resolveMatcher({ diarizationRunId: 'drun_1' })
    await Promise.all([p1, p2])

    expect(embedRecordingLabels).toHaveBeenCalledTimes(1)
    expect(runMatcher).toHaveBeenCalledTimes(1)
  })

  it('a rejected embed is shared by both callers (each gets []) and the entry clears for a retry', async () => {
    const handler = handlers.get('speakers:getSuggestions')!
    // First wave: embed rejects → both callers get the handler's [] result.
    embedRecordingLabels.mockRejectedValueOnce(new Error('decode boom') as never)
    const [r1, r2] = await Promise.all([handler({}, 'rec_Y'), handler({}, 'rec_Y')])
    expect((r1 as { success: boolean; data: unknown[] }).data).toEqual([])
    expect((r2 as { success: boolean; data: unknown[] }).data).toEqual([])
    expect(embedRecordingLabels).toHaveBeenCalledTimes(1) // shared, not double

    // Second wave: the entry was cleared on settle, so a fresh call re-invokes embed+match.
    embedRecordingLabels.mockResolvedValueOnce(undefined as never)
    const p = handler({}, 'rec_Y')
    await new Promise((r) => setImmediate(r))
    resolveMatcher({ diarizationRunId: 'drun_2' })
    await p
    expect(embedRecordingLabels).toHaveBeenCalledTimes(2)
    expect(runMatcher).toHaveBeenCalledTimes(1) // first wave never reached runMatcher (embed threw)
  })
})
```

  Note: the rejection test relies on `runMatcher` only being entered when embed resolves. In the first wave embed rejects before `runMatcher` is called, so `runMatcher`'s pending promise (and `resolveMatcher`) is only wired in the second wave.

- [ ] **Step 2: Run it, verify it fails.**
  `cd apps/electron && npx vitest run electron/main/ipc/__tests__/speakers-getsuggestions-singleflight.test.ts`
  Expected: FAIL — without single-flight, `embedRecordingLabels`/`runMatcher` are each called twice.

- [ ] **Step 3: Minimal implementation.** In `speakers-handlers.ts`:
  (a) After the imports / `mainWindow` declaration (after line 35), add the in-flight map and helper:
```typescript
/**
 * Per-recording single-flight for the expensive getSuggestions compute (spec §5). getSuggestions
 * fires on recording-change AND every onChanged edit, and two IPC calls can overlap; the renderer
 * token guard does not abort in-flight calls. Dedupe the WHOLE embedRecordingLabels+runMatcher
 * sequence by recordingId so two first-opens can't both decode/embed or mint distinct run ids.
 */
const getSuggestionsInFlight = new Map<string, Promise<MatcherResult>>()

function getSuggestionsSequence(recordingId: string): Promise<MatcherResult> {
  const existing = getSuggestionsInFlight.get(recordingId)
  if (existing) return existing
  const p = (async (): Promise<MatcherResult> => {
    await embedRecordingLabels(recordingId)
    return (await runMatcher(recordingId)) as MatcherResult
  })()
  getSuggestionsInFlight.set(recordingId, p)
  // Clear on settle (success OR failure) so a later call re-computes; a rejection is shared by all
  // current awaiters (the handler try/catch maps it to []), then evicted here.
  p.finally(() => {
    if (getSuggestionsInFlight.get(recordingId) === p) getSuggestionsInFlight.delete(recordingId)
  }).catch(() => { /* rejection already surfaced to awaiters; nothing to do here */ })
  return p
}

/** Evict any in-flight getSuggestions compute for a recording. Called by mutation handlers (merge,
 *  updateTurns) AFTER they delete embeddings, so a compute that started pre-edit is not adopted by
 *  the renderer's post-edit refresh — the next getSuggestions starts fresh. */
export function clearSuggestionsInFlight(recordingId: string): void {
  getSuggestionsInFlight.delete(recordingId)
}
```
  (b) In the `speakers:getSuggestions` handler, replace the two lines (`speakers-handlers.ts:391-392`):
```typescript
        await embedRecordingLabels(id)
        const { diarizationRunId } = await runMatcher(id) as MatcherResult
```
  with:
```typescript
        const { diarizationRunId } = await getSuggestionsSequence(id)
```

- [ ] **Step 4: Run tests, verify pass.**
  `cd apps/electron && npx vitest run electron/main/ipc/__tests__/speakers-getsuggestions-singleflight.test.ts`
  Expected: PASS (2 tests — overlap dedupe + rejection-shared-and-cleared).

- [ ] **Step 5: Commit.**
  `cd apps/electron && git add electron/main/ipc/speakers-handlers.ts electron/main/ipc/__tests__/speakers-getsuggestions-singleflight.test.ts && git commit -m "feat(electron): single-flight the getSuggestions embed+match sequence per recording"`

---

### Task 6: Paired deletes (stale-model cleanup, updateTurns, merge, both re-transcribe sites, recording delete)

There are FIVE call sites of `deleteLabelEmbeddingsForRecording` in the codebase (verified by grep, excluding the definition): `voiceprint-service.ts:478` (stale-model cleanup in `embedRecordingLabels`), `transcription.ts:481` (Stage-1 re-transcribe), `speakers-handlers.ts:264` (merge), `recording-handlers.ts:322` (the `recordings:transcribe` re-transcribe handler). Spec §6 requires a paired `deleteWindowEmbeddingsForRecording` at EACH, plus the recording-delete path. This task wires ALL of them.

**Recording-delete reality (read before editing — corrects the spec's stale reference):** the spec §Components line "Recording-delete path (`database.ts deleteRecording` / `recording-handlers.ts`)" is stale. `database.ts` has NO `deleteRecording` (grep confirms: the only `deleteRecording` is in `file-storage.ts`, which deletes a FILE by path). Both user-facing deletes are SOFT deletes: `recordings:delete` / `recordings:deleteBatch` call `deleteRecordingFile(path)` then `updateRecordingStatus(id, 'deleted')` (the recording ROW survives); and `deleteRecordingLocal` (`database.ts:2604`, called by `storage-policy.ts:261` auto-cleanup) only nulls `file_path` / sets `on_local=0` / `location='deleted'` (the ROW also survives). There is NO hard row-delete anywhere, so FK cascade is moot and embeddings would orphan in every path. We therefore pair the window+label deletes at the IPC delete handlers (where a `recordingId` is in scope and the user-initiated delete happens) AND inside `deleteRecordingLocal` (the storage-policy cleanup path). The `improvement-high "wired to the wrong site"` claim that `deleteRecordingLocal` is a hard row-delete is incorrect — verified it is a soft update — so we cover both soft paths rather than hunt for a nonexistent hard-delete.

**Files:**
- Modify `apps/electron/electron/main/services/voiceprint-service.ts` (add `deleteWindowEmbeddingsForRecording` to its `database` import block; call it right after `deleteLabelEmbeddingsForRecording(recordingId)` at `voiceprint-service.ts:478`)
- Modify `apps/electron/electron/main/ipc/speakers-handlers.ts` (import + call `deleteWindowEmbeddingsForRecording` in `transcripts:updateTurns` and `speakers:merge`; in `updateTurns` ALSO call `deleteLabelEmbeddingsForRecording` + `clearSuggestionsInFlight`; in `merge` call `clearSuggestionsInFlight`)
- Modify `apps/electron/electron/main/services/transcription.ts` (call `deleteWindowEmbeddingsForRecording` alongside the existing `deleteLabelEmbeddingsForRecording` at `transcription.ts:481`)
- Modify `apps/electron/electron/main/ipc/recording-handlers.ts` (add ONLY `deleteWindowEmbeddingsForRecording` to the import — `deleteLabelEmbeddingsForRecording` is ALREADY imported at line 40; add the paired window delete at the `recordings:transcribe` re-transcribe site line 322; add BOTH label+window deletes in the `recordings:delete` and `recordings:deleteBatch` soft-delete blocks — those calls are genuinely missing)
- Modify `apps/electron/electron/main/services/database.ts` (call `deleteLabelEmbeddingsForRecording` + `deleteWindowEmbeddingsForRecording` inside `deleteRecordingLocal` at `database.ts:2604` so the storage-policy auto-cleanup path doesn't orphan embeddings)
- Modify `apps/electron/electron/main/ipc/__tests__/recording-handlers.test.ts` (REQUIRED: add `deleteWindowEmbeddingsForRecording: vi.fn()` to the `vi.mock('../../services/database', ...)` factory — `deleteLabelEmbeddingsForRecording: vi.fn()` is already there at line 37 — otherwise the existing `recordings:delete` test hits an undefined mock export → TypeError; finding "recording-handlers existing test will throw")
- Modify `apps/electron/electron/main/ipc/__tests__/speakers-handlers.test.ts` (REQUIRED: add `deleteWindowEmbeddingsForRecording: vi.fn()` to its `vi.mock('../../services/database', ...)` factory at line 9-24 — it currently has `deleteLabelEmbeddingsForRecording: vi.fn()` at line 20 but NOT the window variant; without it the existing `speakers:merge` test (line 639) and any `transcripts:updateTurns` test hit an undefined mock → TypeError)
- Test: create `apps/electron/electron/main/ipc/__tests__/speakers-paired-deletes.test.ts` (new)

**Interfaces:**
- Consumes: `deleteWindowEmbeddingsForRecording(recordingId)`, `deleteLabelEmbeddingsForRecording(recordingId)` (database); `clearSuggestionsInFlight(recordingId)` (Task 5, same `speakers-handlers.ts` module).
- Produces: window rows are deleted wherever label embeddings are invalidated (all five sites), plus on both soft-delete recording paths; per-turn reassign now also drops LABEL embeddings so identity/merge scoring recomputes (not just window/mixed).

- [ ] **Step 1: Write the failing test.** Create `apps/electron/electron/main/ipc/__tests__/speakers-paired-deletes.test.ts`. It exercises the `transcripts:updateTurns` and `speakers:merge` handlers and asserts `deleteWindowEmbeddingsForRecording` was called.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: class {},
}))

const dbMocks = {
  upsertRecordingSpeaker: vi.fn(), deleteRecordingSpeaker: vi.fn(),
  getRecordingSpeaker: vi.fn(() => undefined), getRecordingSpeakers: vi.fn(() => []),
  getContactById: vi.fn(() => ({ id: 'c', name: 'C' })),
  getTranscriptByRecordingId: vi.fn(() => ({ id: 't', turns: JSON.stringify([{ speaker: 'A', startMs: 0, endMs: 1000, text: 'x' }, { speaker: 'B', startMs: 1000, endMs: 2000, text: 'y' }]) })),
  updateTranscriptTurns: vi.fn(), deleteVoiceprintsBySource: vi.fn(),
  getPendingSuggestions: vi.fn(() => []), getSelfContactId: vi.fn(() => null),
  deleteLabelEmbeddingsForRecording: vi.fn(), deleteWindowEmbeddingsForRecording: vi.fn(),
  expireSuggestionsForRecording: vi.fn(), acceptSuggestion: vi.fn(), dismissSuggestion: vi.fn(),
}
vi.mock('../../services/database', () => dbMocks)
vi.mock('../../services/voiceprint-service', () => ({ embedRecordingLabels: vi.fn(), captureVoiceprint: vi.fn() }))
vi.mock('../../services/voiceprint/speaker-matcher', () => ({ runMatcher: vi.fn(async () => ({ diarizationRunId: null })) }))

describe('paired window-embedding deletes', () => {
  beforeEach(async () => {
    handlers.clear()
    Object.values(dbMocks).forEach((m) => m.mockClear())
    const mod = await import('../speakers-handlers')
    mod.registerSpeakersHandlers()
  })

  it('transcripts:updateTurns deletes BOTH window and label embeddings for the recording', async () => {
    const handler = handlers.get('transcripts:updateTurns')!
    await handler({}, { recordingId: 'rec_1', turns: [{ speaker: 'A', startMs: 0, endMs: 1000, text: 'x' }] })
    expect(dbMocks.deleteWindowEmbeddingsForRecording).toHaveBeenCalledWith('rec_1')
    // Per-turn reassign must also drop LABEL embeddings so identity/merge scoring recomputes from
    // the new clean-speech set (not just window/mixed). (improvement-high "label embeddings stale".)
    expect(dbMocks.deleteLabelEmbeddingsForRecording).toHaveBeenCalledWith('rec_1')
  })

  it('speakers:merge deletes window embeddings for the recording', async () => {
    const handler = handlers.get('speakers:merge')!
    await handler({}, { recordingId: 'rec_1', fromLabel: 'A', toLabel: 'B' })
    expect(dbMocks.deleteWindowEmbeddingsForRecording).toHaveBeenCalledWith('rec_1')
  })
})
```

- [ ] **Step 2: Run it, verify it fails.**
  `cd apps/electron && npx vitest run electron/main/ipc/__tests__/speakers-paired-deletes.test.ts`
  Expected: FAIL — `deleteWindowEmbeddingsForRecording` is never called (not yet wired).

- [ ] **Step 3: Minimal implementation.**
  (a) `voiceprint-service.ts` — add `deleteWindowEmbeddingsForRecording` to its `database` import block (after `deleteLabelEmbeddingsForRecording`, `voiceprint-service.ts:26`):
```typescript
  deleteLabelEmbeddingsForRecording,
  deleteWindowEmbeddingsForRecording,
```
  Then in `embedRecordingLabels`, inside the `if (hasStale) { ... }` branch (after `deleteLabelEmbeddingsForRecording(recordingId)`, `voiceprint-service.ts:478`), add:
```typescript
    deleteWindowEmbeddingsForRecording(recordingId)
```
  (Stale-model cleanup must drop window rows too; otherwise a model swap orphans the old window rows permanently — they'd be filtered by `model_version` on read but never reclaimed. Finding "stale-model cleanup not paired".)

  (b) `speakers-handlers.ts` — add `deleteWindowEmbeddingsForRecording` to the database import block (after `deleteLabelEmbeddingsForRecording`, line 20):
```typescript
  deleteLabelEmbeddingsForRecording,
  deleteWindowEmbeddingsForRecording,
```
  In `speakers:merge`, after the existing `deleteLabelEmbeddingsForRecording(recordingId)` (line 264), add:
```typescript
        deleteWindowEmbeddingsForRecording(recordingId)
        clearSuggestionsInFlight(recordingId) // evict any pre-edit compute (Task 5)
```
  In `transcripts:updateTurns`, after `updateTranscriptTurns(recordingId, turns as Turn[])` (line 366), add:
```typescript
        // Per-turn reassign edits turn membership without minting a new run id. The window
        // fingerprint already forces a window recompute, but LABEL embeddings (identity/merge
        // scoring) are computed from the clean-speech set and would otherwise stay stale — so drop
        // BOTH, matching what speakers:merge does, and evict any in-flight compute so the renderer's
        // post-edit refresh starts fresh. (spec §6; improvement-high "label embeddings stale".)
        deleteLabelEmbeddingsForRecording(recordingId)
        deleteWindowEmbeddingsForRecording(recordingId)
        clearSuggestionsInFlight(recordingId)
```
  (`clearSuggestionsInFlight` and the two delete functions are all in scope: `clearSuggestionsInFlight` is defined in this same `speakers-handlers.ts` module in Task 5; the deletes are imported above.)

  (c) `transcription.ts` — add `deleteWindowEmbeddingsForRecording` to the database import block (after `deleteLabelEmbeddingsForRecording`, line 32):
```typescript
  deleteLabelEmbeddingsForRecording,
  deleteWindowEmbeddingsForRecording,
```
  and after `deleteLabelEmbeddingsForRecording(recordingId)` (line 481) add:
```typescript
    deleteWindowEmbeddingsForRecording(recordingId)
```
  (d) `recording-handlers.ts` — add ONLY `deleteWindowEmbeddingsForRecording` to the database import block (`deleteLabelEmbeddingsForRecording` is ALREADY imported at line 40 — do NOT re-add it or you get a duplicate-import typecheck/lint failure; finding "duplicate import"):
```typescript
  deleteLabelEmbeddingsForRecording,
  deleteWindowEmbeddingsForRecording,
```
  In the `recordings:transcribe` handler, inside the `if (existingTranscript?.full_text) { ... }` block, after `deleteLabelEmbeddingsForRecording(id)` (line 322), add (this is the SECOND re-transcribe drop site — finding "re-transcribe gap"):
```typescript
        deleteWindowEmbeddingsForRecording(id)
```
  In `recordings:delete`, inside the `if (deleted)` block (after `updateRecordingStatus(result.data.id, 'deleted')`, line 182), add:
```typescript
          deleteLabelEmbeddingsForRecording(result.data.id)
          deleteWindowEmbeddingsForRecording(result.data.id)
```
  In `recordings:deleteBatch`, inside the `if (wasDeleted)` block (after `updateRecordingStatus(id, 'deleted')`, line 217), add:
```typescript
              deleteLabelEmbeddingsForRecording(id)
              deleteWindowEmbeddingsForRecording(id)
```
  (e) `database.ts` — inside `deleteRecordingLocal(id)` (`database.ts:2604`), after the `updateRecordingLifecycle(...)` call that ends the function body, add the paired cleanup so the storage-policy auto-cleanup path doesn't orphan embeddings:
```typescript
  deleteLabelEmbeddingsForRecording(id)
  deleteWindowEmbeddingsForRecording(id)
```
  (Both functions are defined later in this same `database.ts` module — function declarations hoist, so the forward reference is fine. `deleteRecordingLocal` is a soft delete that nulls the file and flips `location`; the row survives but its embeddings are stale once the local audio is gone, so reclaim them here.)

  (f) `recording-handlers.test.ts` — add `deleteWindowEmbeddingsForRecording: vi.fn()` to the `vi.mock('../../services/database', ...)` factory (next to the existing `deleteLabelEmbeddingsForRecording: vi.fn()` at line 37). Without it the existing `recordings:delete` test calls an undefined mock export and throws (finding "recording-handlers existing test will throw").
  (g) `speakers-handlers.test.ts` — add `deleteWindowEmbeddingsForRecording: vi.fn()` to its `vi.mock('../../services/database', ...)` factory (next to the existing `deleteLabelEmbeddingsForRecording: vi.fn()` at line 20). Without it the existing `speakers:merge` test and any `transcripts:updateTurns` test throw on the new undefined export. (`clearSuggestionsInFlight` is a real export of the module under test, not a database mock, so no mock entry is needed for it.)
  (h) `voiceprint-service.test.ts` — add `deleteWindowEmbeddingsForRecording: vi.fn()` to its database mock factory (next to `deleteLabelEmbeddingsForRecording: vi.fn()` at line 115); the stale-model test at line 881 calls `embedRecordingLabels`, which now also calls the window delete.
  (i) `transcription.test.ts` AND `transcription-speaker-options.test.ts` — add `deleteWindowEmbeddingsForRecording: vi.fn()` to each database mock factory (next to `deleteLabelEmbeddingsForRecording: vi.fn()` at `transcription.test.ts:54` / `transcription-speaker-options.test.ts:89`); the Stage-1 re-transcribe path at `transcription.ts:481` now calls it.

- [ ] **Step 4: Run tests, verify pass.**
  `cd apps/electron && npx vitest run electron/main/ipc/__tests__/speakers-paired-deletes.test.ts`
  Expected: PASS (2 tests).
  Re-run the existing recording-handlers suite (the `deleteWindowEmbeddingsForRecording: vi.fn()` added to its mock factory in Step 3(f) keeps the existing `recordings:delete` test green):
  `cd apps/electron && npx vitest run electron/main/ipc/__tests__/recording-handlers.test.ts`
  Expected: PASS.
  Re-run the existing voiceprint-service + transcription + speakers-handlers suites (their database-mock factories were updated in Step 3 (g)/(h)/(i) to include `deleteWindowEmbeddingsForRecording: vi.fn()`):
  `cd apps/electron && npx vitest run electron/main/services/__tests__/voiceprint-service.test.ts electron/main/services/__tests__/transcription.test.ts electron/main/services/__tests__/transcription-speaker-options.test.ts electron/main/ipc/__tests__/speakers-handlers.test.ts`
  Expected: PASS. (If a suite the grep missed still errors with "No deleteWindowEmbeddingsForRecording export is defined on the mock", add `deleteWindowEmbeddingsForRecording: vi.fn()` to that file's database-mock factory, include it in the commit, and re-run.)

- [ ] **Step 5: Commit.**
  `cd apps/electron && git add electron/main/services/voiceprint-service.ts electron/main/ipc/speakers-handlers.ts electron/main/services/transcription.ts electron/main/ipc/recording-handlers.ts electron/main/services/database.ts electron/main/ipc/__tests__/speakers-paired-deletes.test.ts electron/main/ipc/__tests__/recording-handlers.test.ts electron/main/ipc/__tests__/speakers-handlers.test.ts electron/main/services/__tests__/voiceprint-service.test.ts electron/main/services/__tests__/transcription.test.ts electron/main/services/__tests__/transcription-speaker-options.test.ts && git commit -m "feat(electron): pair window-embedding deletes at all 5 label-delete sites + both soft-delete paths"`

**Out of scope (deliberate):** `storage:delete-recording` (`storage-handlers.ts:183`) deletes only a FILE by `filePath` and has no `recordingId` in scope (and never touches the DB), so it cannot trivially pair the delete. Window rows for a file removed via that low-level path can orphan. This is accepted: it is not the user-facing recording-delete (the `recordings:delete`/`deleteBatch` IPC handlers are), and the orphaned rows are inert (filtered by recording on read; reclaimed if the recording is later deleted via the covered paths). Resolving a `recordingId` from a `filePath` there is left as a future cleanup, not part of this spec's scope.

---

### Task 7: Update the two in-memory-cache tests to DB-backed equivalents

**Files:**
- Modify `apps/electron/electron/main/services/voiceprint/__tests__/speaker-matcher.test.ts` (remove `__clearWindowEmbeddingCache` usage; rewrite the two perf tests)

**Interfaces:**
- Consumes: the DB-backed `getWindowEmbeddings` + DB mocks added in Task 4.
- Produces: a green `speaker-matcher.test.ts` proving (a) a DB hit avoids decode/embed and (b) a fingerprint change forces re-decode/re-embed.

- [ ] **Step 1: Write the failing test (rewrite).** In `speaker-matcher.test.ts`:
  (The `__clearWindowEmbeddingCache` import (line 7) and `beforeEach` call (line 68) were ALREADY removed in Task 4 Step 1(i)/(ii) so the file stays runnable — do NOT touch them here.)
  Replace the two old perf tests (`perf: caches window embeddings per (recording, run) ...` at lines 351-366 and `perf: a new diarization run id re-decodes/re-embeds ...` at lines 368-380) and the `longLabelRows` helper (lines 337-349) with DB-backed equivalents:

```typescript
  /** A long label whose window embeddings drive mixed detection. */
  const longLabelRows = (runId: string) =>
    [
      {
        id: 'le_M', recording_id: 'rec_1', file_label: 'M', model_id: VOICEPRINT_MODEL_ID,
        dim: 256, embedding: embBlob(SAME_VEC), clean_speech_ms: 25_000, diarization_run_id: runId,
      },
    ] as never

  const longTurns = [
    { speaker: 'M', startMs: 0, endMs: 22_000, text: 'a' },
    { speaker: 'M', startMs: 22_000, endMs: 44_000, text: 'b' },
  ]

  it('perf: a DB hit (matching fingerprint) serves window embeddings without re-decode/re-embed', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue(longLabelRows('drun_1'))
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([] as never)
    vi.mocked(db.getRecordingById).mockReturnValue({ id: 'rec_1', file_path: '/r/rec.wav' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({ id: 't1', turns: JSON.stringify(longTurns) } as never)
    const fp = labelTurnsFingerprint(longTurns as never, 'M', VOICEPRINT_MODEL_ID, 1)
    vi.mocked(db.getWindowEmbeddingsForRecording).mockReturnValue([
      { fileLabel: 'M', fingerprint: fp, embeddings: [embBlob(DIFF_VEC), embBlob(SAME_VEC)] },
    ] as never)

    await runMatcher('rec_1')
    await runMatcher('rec_1')
    await runMatcher('rec_1')

    // Persisted hit each call → never decode or embed.
    expect(vi.mocked(vp.decodeRecordingPcm16k)).not.toHaveBeenCalled()
    expect(vi.mocked(vp.embedLabelWindows)).not.toHaveBeenCalled()
    // But scoring re-runs and a mixed suggestion is produced every call.
    expect(vi.mocked(db.insertSuggestion).mock.calls.filter((c) => c[0].kind === 'mixed').length).toBe(3)
  })

  it('perf: a changed fingerprint (edited turns) re-decodes/re-embeds and re-persists', async () => {
    vi.mocked(db.getLabelEmbeddingsForRecording).mockReturnValue(longLabelRows('drun_1'))
    vi.mocked(db.getContactsWithActiveVoiceprints).mockReturnValue([] as never)
    vi.mocked(db.getRecordingById).mockReturnValue({ id: 'rec_1', file_path: '/r/rec.wav' } as never)
    vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({ id: 't1', turns: JSON.stringify(longTurns) } as never)
    vi.mocked(vp.embedLabelWindows).mockResolvedValue([DIFF_VEC, SAME_VEC])

    // First call: DB empty → miss → compute + persist.
    vi.mocked(db.getWindowEmbeddingsForRecording).mockReturnValue([] as never)
    await runMatcher('rec_1')

    // Second call: persisted rows exist but under a STALE fingerprint → miss → recompute.
    vi.mocked(db.getWindowEmbeddingsForRecording).mockReturnValue([
      { fileLabel: 'M', fingerprint: 'STALE', embeddings: [embBlob(SAME_VEC)] },
    ] as never)
    await runMatcher('rec_1')

    expect(vi.mocked(vp.decodeRecordingPcm16k)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(vp.embedLabelWindows)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(db.replaceWindowEmbeddingsForLabel)).toHaveBeenCalledTimes(2)
  })
```

- [ ] **Step 2: Run it, verify it fails (or errors first on the removed symbol).**
  `cd apps/electron && npx vitest run electron/main/services/voiceprint/__tests__/speaker-matcher.test.ts`
  Expected: before the rewrite is fully applied, the file errors on `__clearWindowEmbeddingCache` not being exported. After applying the rewrite, all tests run; if any expectation is wrong it fails here.

- [ ] **Step 3: Minimal implementation.** No production code changes — Task 4 already implemented the behavior. This task only aligns the tests. If the run reveals a real production gap (e.g. `replaceWindowEmbeddingsForLabel` not called twice), fix it in `speaker-matcher.ts` `getWindowEmbeddings` rather than weakening the test.

- [ ] **Step 4: Run tests, verify pass.**
  `cd apps/electron && npx vitest run electron/main/services/voiceprint/__tests__/speaker-matcher.test.ts`
  Expected: PASS — all tests in the file (the original identity/merge/mixed/privacy/idempotency tests + the Task-4 DB-backed describe + these two rewritten perf tests).

- [ ] **Step 5: Commit.**
  `cd apps/electron && git add electron/main/services/voiceprint/__tests__/speaker-matcher.test.ts && git commit -m "test(electron): convert in-memory window-cache perf tests to DB-backed equivalents"`

---

### Task 8: Full quality gate

**Files:** none (verification only).

**Interfaces:** Consumes everything above.

- [ ] **Step 1: Typecheck.**
  `cd apps/electron && npm run typecheck`
  Expected: exit 0, no errors. (If `WindowEmbeddingRow`/accessor imports are unused anywhere, remove them.)

- [ ] **Step 2: Lint.**
  `cd apps/electron && npm run lint`
  Expected: exit 0. Fix any 120-col or unused-import warnings introduced.

- [ ] **Step 3: Full test suite.**
  `cd apps/electron && npm run test:run`
  Expected: all suites green, including `window-embeddings-db.test.ts`, `label-fingerprint.test.ts`, `speaker-matcher.test.ts`, `speakers-getsuggestions-singleflight.test.ts`, `speakers-paired-deletes.test.ts`, and the pre-existing `recording-handlers.test.ts`.

- [ ] **Step 4: Confirm no stray references to removed symbols.**
  `cd apps/electron && grep -rn "WINDOW_EMB_CACHE\|invalidateWindowEmbeddings\|__clearWindowEmbeddingCache\|windowCacheKey" electron src`
  Expected: no matches (all removed). If any consumer outside the tests referenced `invalidateWindowEmbeddings`, replace that call with `deleteWindowEmbeddingsForRecording(recordingId)` from `database` and re-run gates.
  Also confirm the model version is single-sourced (no stray local `WINDOW_MODEL_VERSION` const remains in `speaker-matcher.ts` — Task 4 uses the imported `VOICEPRINT_MODEL_VERSION`):
  `cd apps/electron && grep -rn "WINDOW_MODEL_VERSION" electron`
  Expected: no matches.

- [ ] **Step 5: Commit (only if Step 4 required edits).**
  `cd apps/electron && git add -A && git commit -m "chore(electron): drop residual references to removed in-memory window cache"`
