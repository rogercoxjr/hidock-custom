# Hosted Hub — Plan 0a: Headless Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the data/config/storage layer of `apps/electron` run in plain Node (zero Electron imports), on `better-sqlite3`, booting to schema v33 — the bedrock every later sub-plan builds on.

**Architecture:** Introduce a tiny `electron/main/runtime/` abstraction for paths and secret encryption (replacing `app.getPath()` and `safeStorage`). De-Electron `config.ts`. Swap `sql.js` for `better-sqlite3` in `database.ts` (the existing SQLite file format opens directly — no data migration), preserving the public helper API (`queryAll`/`queryOne`/`run`/`runNoSave`/`runInTransaction`/`runMany`). Convert the raw-handle call sites that the engine swap breaks. Prove it with a headless boot entry + an electron-import guard test.

**Tech Stack:** Node 20+, TypeScript, `better-sqlite3`, Vitest, Node `crypto` (AES-256-GCM).

## Global Constraints

- **No `from 'electron'` imports** in `config.ts`, `file-storage.ts`, `database.ts`, or any new `runtime/` module. (Verified by a guard test in Task 6.)
- **Schema version is `33`** — `SCHEMA_VERSION` in `database.ts:11`. A fresh boot must end at `schema_version = 33`.
- **Public DB helper API is unchanged** — later code depends on these exact names/signatures: `initializeDatabase(): Promise<void>`, `getDatabase(): Database.Database`, `closeDatabase(): void`, `saveDatabase(): void`, `queryAll<T>(sql, params?): T[]`, `queryOne<T>(sql, params?): T | undefined`, `run(sql, params?): void`, `runNoSave(sql, params?): void`, `runInTransaction<T>(fn): T`, `runMany(sql, items[][]): void`.
- **`better-sqlite3` binding rules:** parameters are passed **spread** (`.run(...params)`, `.all(...params)`, `.get(...params)`). It rejects `undefined` and JS `boolean` binds — coerce `undefined → null` and `boolean → 0|1` at call sites surfaced by failing tests.
- **Data root comes from `process.env.HIDOCK_DATA_ROOT`** (dev default: `<cwd>/.hidock-data`). Config path from `process.env.HIDOCK_CONFIG_PATH` (default `<dataRoot>/config.json`). Secret key from `process.env.HIDOCK_SECRET_KEY` (absent ⇒ plaintext fallback, mirroring `safeStorage`-unavailable behavior).
- **Line length 120**, TypeScript strict, follow existing code style.
- **Branch:** `feat/hosted-knowledge-hub`. Run all commands from `apps/electron/`.

---

### Task 1: better-sqlite3 dependency + runtime path resolver

**Files:**
- Modify: `apps/electron/package.json` (add `better-sqlite3` + `@types/better-sqlite3`)
- Create: `apps/electron/electron/main/runtime/env.ts`
- Test: `apps/electron/electron/main/runtime/__tests__/env.test.ts`

**Interfaces:**
- Produces: `getDataRoot(): string`, `getConfigPath(): string` (both from `runtime/env.ts`).

- [ ] **Step 1: Install the dependency**

Run:
```bash
npm install better-sqlite3 && npm install -D @types/better-sqlite3
```
Expected: `package.json` gains `"better-sqlite3"` under dependencies and `"@types/better-sqlite3"` under devDependencies; `electron-builder install-app-deps` (postinstall) rebuilds the native module.

- [ ] **Step 2: Write the failing test**

Create `electron/main/runtime/__tests__/env.test.ts`:
```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'path'
import { getDataRoot, getConfigPath } from '../env'

describe('runtime/env', () => {
  const original = { ...process.env }
  afterEach(() => {
    process.env = { ...original }
  })

  it('uses HIDOCK_DATA_ROOT when set', () => {
    process.env.HIDOCK_DATA_ROOT = '/data'
    expect(getDataRoot()).toBe('/data')
  })

  it('falls back to <cwd>/.hidock-data when unset', () => {
    delete process.env.HIDOCK_DATA_ROOT
    expect(getDataRoot()).toBe(join(process.cwd(), '.hidock-data'))
  })

  it('derives config path under the data root by default', () => {
    process.env.HIDOCK_DATA_ROOT = '/data'
    delete process.env.HIDOCK_CONFIG_PATH
    expect(getConfigPath()).toBe(join('/data', 'config.json'))
  })

  it('honors HIDOCK_CONFIG_PATH override', () => {
    process.env.HIDOCK_CONFIG_PATH = '/etc/hidock/config.json'
    expect(getConfigPath()).toBe('/etc/hidock/config.json')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run electron/main/runtime/__tests__/env.test.ts`
Expected: FAIL — cannot find module `../env`.

- [ ] **Step 4: Write minimal implementation**

Create `electron/main/runtime/env.ts`:
```typescript
import { join } from 'path'

/**
 * Root directory for all app data (db, recordings, transcripts, config).
 * Set HIDOCK_DATA_ROOT in production (the Docker volume, e.g. /data).
 * Dev default keeps data out of the source tree under <cwd>/.hidock-data.
 */
export function getDataRoot(): string {
  return process.env.HIDOCK_DATA_ROOT || join(process.cwd(), '.hidock-data')
}

/** Absolute path to config.json. Defaults to <dataRoot>/config.json. */
export function getConfigPath(): string {
  return process.env.HIDOCK_CONFIG_PATH || join(getDataRoot(), 'config.json')
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run electron/main/runtime/__tests__/env.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json electron/main/runtime/env.ts electron/main/runtime/__tests__/env.test.ts
git commit -m "feat(0a): add better-sqlite3 + runtime path resolver"
```

---

### Task 2: Node-crypto secret encryption (replaces Electron safeStorage)

**Files:**
- Create: `apps/electron/electron/main/runtime/secrets.ts`
- Test: `apps/electron/electron/main/runtime/__tests__/secrets.test.ts`

**Interfaces:**
- Produces: `encryptSensitive(value: string): string`, `decryptSensitive(value: string): string`. Encrypted values carry the `__enc__` prefix (unchanged from the current convention, so on-disk format stays compatible with code that checks the prefix).

- [ ] **Step 1: Write the failing test**

Create `electron/main/runtime/__tests__/secrets.test.ts`:
```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { encryptSensitive, decryptSensitive } from '../secrets'

describe('runtime/secrets', () => {
  const original = { ...process.env }
  afterEach(() => { process.env = { ...original } })

  it('round-trips a value when a key is configured', () => {
    process.env.HIDOCK_SECRET_KEY = 'test-key-please-change'
    const enc = encryptSensitive('sk-secret-123')
    expect(enc.startsWith('__enc__')).toBe(true)
    expect(enc).not.toContain('sk-secret-123')
    expect(decryptSensitive(enc)).toBe('sk-secret-123')
  })

  it('never double-wraps an already-encrypted value', () => {
    process.env.HIDOCK_SECRET_KEY = 'test-key-please-change'
    const enc = encryptSensitive('abc')
    expect(encryptSensitive(enc)).toBe(enc)
  })

  it('falls back to plaintext when no key is set', () => {
    delete process.env.HIDOCK_SECRET_KEY
    expect(encryptSensitive('abc')).toBe('abc')
    expect(decryptSensitive('abc')).toBe('abc')
  })

  it('returns empty string unchanged', () => {
    process.env.HIDOCK_SECRET_KEY = 'test-key-please-change'
    expect(encryptSensitive('')).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/main/runtime/__tests__/secrets.test.ts`
Expected: FAIL — cannot find module `../secrets`.

- [ ] **Step 3: Write minimal implementation**

Create `electron/main/runtime/secrets.ts`:
```typescript
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

const PREFIX = '__enc__'

/** Derive a 32-byte AES key from HIDOCK_SECRET_KEY, or null if unset. */
function getKey(): Buffer | null {
  const secret = process.env.HIDOCK_SECRET_KEY
  if (!secret) return null
  return scryptSync(secret, 'hidock-config-salt', 32)
}

/**
 * Encrypt a sensitive config value with AES-256-GCM, '__enc__'-prefixed.
 * No key configured ⇒ returns plaintext (mirrors safeStorage-unavailable).
 * Already-encrypted ⇒ returned as-is (never double-wrap).
 */
export function encryptSensitive(value: string): string {
  if (!value || value.startsWith(PREFIX)) return value
  const key = getKey()
  if (!key) return value
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64')
}

/** Inverse of encryptSensitive. Non-prefixed or undecryptable values pass through. */
export function decryptSensitive(value: string): string {
  if (!value || !value.startsWith(PREFIX)) return value
  const key = getKey()
  if (!key) return value
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64')
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const enc = raw.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
  } catch {
    return value
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/main/runtime/__tests__/secrets.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/main/runtime/secrets.ts electron/main/runtime/__tests__/secrets.test.ts
git commit -m "feat(0a): node-crypto secret encryption (replaces safeStorage)"
```

---

### Task 3: De-Electron `config.ts`

**Files:**
- Modify: `apps/electron/electron/main/services/config.ts` (lines 1, 8–25, 133, 209–211)
- Test: `apps/electron/electron/main/services/__tests__/config.headless.test.ts`

**Interfaces:**
- Consumes: `getConfigPath`, `getDataRoot` (Task 1); `encryptSensitive`, `decryptSensitive` (Task 2).
- Produces: unchanged public API — `initializeConfig()`, `getConfig()`, `saveConfig()`, `updateConfig()`, `getConfigPath()`, `getDataPath()`, `encryptSensitive` (re-exported).

- [ ] **Step 1: Write the failing test**

Create `electron/main/services/__tests__/config.headless.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('config (headless)', () => {
  let dir: string
  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-cfg-'))
    process.env.HIDOCK_DATA_ROOT = dir
    delete process.env.HIDOCK_CONFIG_PATH
    process.env.HIDOCK_SECRET_KEY = 'test-key'
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.HIDOCK_DATA_ROOT
    delete process.env.HIDOCK_SECRET_KEY
  })

  it('initializes a config file and defaults dataPath to the data root', async () => {
    const { initializeConfig, getConfig, getDataPath } = await import('../config')
    await initializeConfig()
    expect(existsSync(join(dir, 'config.json'))).toBe(true)
    expect(getDataPath()).toBe(dir)
    expect(getConfig().version).toBeTruthy()
  })

  it('persists a sensitive field encrypted, reads it back decrypted', async () => {
    const cfg = await import('../config')
    await cfg.initializeConfig()
    await cfg.updateConfig('transcription', { assemblyaiApiKey: 'secret-abc' })
    const raw = require('fs').readFileSync(join(dir, 'config.json'), 'utf-8')
    expect(raw).not.toContain('secret-abc')        // encrypted on disk
    expect(cfg.getConfig().transcription.assemblyaiApiKey).toBe('secret-abc') // decrypted in memory
  })

  it('imports without pulling in electron', async () => {
    const mod = await import('../config')
    expect(typeof mod.getConfigPath).toBe('function')
  })
})
```
(Add `import { vi } from 'vitest'` at the top.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/main/services/__tests__/config.headless.test.ts`
Expected: FAIL — `config.ts` imports `electron`, which has no headless export for `app`/`safeStorage` (or `app.getPath` throws).

- [ ] **Step 3: Edit `config.ts` — replace the Electron imports and encryption helpers**

Replace lines 1–25:
```typescript
// BEFORE
import { app, safeStorage } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { DEFAULT_SPEAKER_OPTIONS_POLICY } from './asr/speaker-options-policy'
import type { MatchThresholds } from './voiceprint/identity-matcher'

export function encryptSensitive(value: string): string { /* safeStorage impl */ }
function decryptSensitive(value: string): string { /* safeStorage impl */ }
```
```typescript
// AFTER
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { DEFAULT_SPEAKER_OPTIONS_POLICY } from './asr/speaker-options-policy'
import type { MatchThresholds } from './voiceprint/identity-matcher'
import { getConfigPath as resolveConfigPath, getDataRoot } from '../runtime/env'
import { encryptSensitive, decryptSensitive } from '../runtime/secrets'

export { encryptSensitive } // preserve the existing public export
```

- [ ] **Step 4: Edit `config.ts` — data root default (line 133)**
```typescript
// BEFORE
dataPath: join(app.getPath('home'), 'HiDock'),
// AFTER
dataPath: getDataRoot(),
```

- [ ] **Step 5: Edit `config.ts` — config path (lines 209–211)**
```typescript
// BEFORE
export function getConfigPath(): string {
  return join(app.getPath('userData'), 'config.json')
}
// AFTER
export function getConfigPath(): string {
  return resolveConfigPath()
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run electron/main/services/__tests__/config.headless.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Confirm `file-storage.ts` needs no change**

Run: `grep -n "from 'electron'" electron/main/services/file-storage.ts || echo "clean"`
Expected: `clean` — `file-storage.ts` derives all paths from `getDataPath()` (config) and imports no Electron. No edit required.

- [ ] **Step 8: Commit**

```bash
git add electron/main/services/config.ts electron/main/services/__tests__/config.headless.test.ts
git commit -m "feat(0a): de-electron config.ts (runtime paths + node-crypto secrets)"
```

---

### Task 4: Swap `database.ts` from sql.js to better-sqlite3

This is the core task. It converts the engine while preserving the public helper API. The whole file must compile and the DB test suite must pass at the end — so the query helpers AND the boot sequence are converted together.

**Files:**
- Modify: `apps/electron/electron/main/services/database.ts` (lines 1, 8, 1924–2101, 2111–2154, 2191–2251, and the two inline prepared statements at ~3463 and ~3533)
- Test: `apps/electron/electron/main/services/__tests__/database.boot.test.ts`

**Interfaces:**
- Consumes: de-Electroned `config.ts` (Task 3), `getDatabasePath()` from `file-storage.ts`.
- Produces: the unchanged public DB helper API (see Global Constraints), with `getDatabase()` now returning `import('better-sqlite3').Database.Database`.

- [ ] **Step 1: Write the failing test**

Create `electron/main/services/__tests__/database.boot.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('database boot (better-sqlite3)', () => {
  let dir: string
  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-db-'))
    process.env.HIDOCK_DATA_ROOT = dir
  })
  afterEach(async () => {
    const { closeDatabase } = await import('../database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
    delete process.env.HIDOCK_DATA_ROOT
  })

  it('boots a fresh DB to schema version 33', async () => {
    const { initializeFileStorage } = await import('../file-storage')
    const db = await import('../database')
    await initializeFileStorage()
    await db.initializeDatabase()
    const row = db.queryOne<{ version: number }>(
      'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
    )
    expect(row?.version).toBe(33)
  })

  it('queryAll / run round-trip with spread params', async () => {
    const { initializeFileStorage } = await import('../file-storage')
    const db = await import('../database')
    await initializeFileStorage()
    await db.initializeDatabase()
    db.run("INSERT INTO projects (id, name, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)", ['p1', 'Proj'])
    const rows = db.queryAll<{ id: string; name: string }>('SELECT id, name FROM projects WHERE id = ?', ['p1'])
    expect(rows).toEqual([{ id: 'p1', name: 'Proj' }])
  })

  it('runInTransaction rolls back on throw', async () => {
    const { initializeFileStorage } = await import('../file-storage')
    const db = await import('../database')
    await initializeFileStorage()
    await db.initializeDatabase()
    expect(() => db.runInTransaction(() => {
      db.runNoSave("INSERT INTO projects (id, name, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)", ['p2', 'X'])
      throw new Error('boom')
    })).toThrow('boom')
    expect(db.queryOne('SELECT id FROM projects WHERE id = ?', ['p2'])).toBeUndefined()
  })

  it('re-boot on an existing file is idempotent (stays at 33)', async () => {
    const { initializeFileStorage } = await import('../file-storage')
    const db = await import('../database')
    await initializeFileStorage()
    await db.initializeDatabase()
    db.closeDatabase()
    vi.resetModules()
    const db2 = await import('../database')
    await db2.initializeDatabase()
    const row = db2.queryOne<{ version: number }>('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
    expect(row?.version).toBe(33)
  })
})
```
> Note: if the `projects` insert columns differ from the live schema, adjust the column list to a column set that exists on a fresh v33 DB — the point is a real round-trip, not those exact columns.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/main/services/__tests__/database.boot.test.ts`
Expected: FAIL — still on sql.js; `db.export()`/`stmt.step()` semantics and/or `initSqlJs` cause failures, or the import chain still references sql.js types.

- [ ] **Step 3: Edit imports + module global (lines 1, 8)**
```typescript
// BEFORE
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js'
...
let db: SqlJsDatabase | null = null
// AFTER
import Database from 'better-sqlite3'
...
let db: Database.Database | null = null
```

- [ ] **Step 4: Edit `initializeDatabase` open + Phase 1 (lines 1924–1954)**

Replace the open block:
```typescript
// BEFORE
const SQL = await initSqlJs()
if (existsSync(dbPath)) {
  const fileBuffer = readFileSync(dbPath)
  db = new SQL.Database(fileBuffer)
} else {
  db = new SQL.Database()
}
const database = getDatabase()
// AFTER
db = new Database(dbPath)            // opens existing file or creates a new one
db.pragma('journal_mode = WAL')      // concurrent readers + one safe writer
db.pragma('foreign_keys = ON')
const database = getDatabase()
```
In Phase 1 (and Phase 4), every `database.run(sql)` that runs a no-param DDL statement becomes `database.exec(sql)`:
```typescript
// BEFORE (Phase 1, ~line 1949 and Phase 4, ~line 2070)
database.run(sql)
// AFTER
database.exec(sql)
```

- [ ] **Step 5: Edit Phase 2 PRAGMA reads (the `database.exec("PRAGMA table_info(...)")` pattern, ~lines 1961–2046)**

Replace each occurrence of the sql.js result-shape read:
```typescript
// BEFORE
const recordingsInfo = database.exec("PRAGMA table_info(recordings)")
const recCols = recordingsInfo.length > 0 && recordingsInfo[0].values
  ? recordingsInfo[0].values.map(col => col[1]) : []
// AFTER
const recCols = (database.pragma('table_info(recordings)') as Array<{ name: string }>).map(c => c.name)
```
Apply the identical transform to the `knowledge_captures`, `transcription_queue`, `chat_messages`, and `speaker_suggestions` PRAGMA blocks. Each ALTER statement in these blocks changes `database.run(\`ALTER ...\`)` → `database.exec(\`ALTER ...\`)`.

- [ ] **Step 6: Edit Phase 3 version read + insert (lines 2049–2059) and `runMigrations` (line 1912)**
```typescript
// BEFORE (Phase 3)
const versionResult = database.exec('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
const currentVersion = versionResult.length > 0 && versionResult[0].values.length > 0
  ? (versionResult[0].values[0][0] as number) : 0
...
database.run('INSERT INTO schema_version (version) VALUES (?)', [SCHEMA_VERSION])
// AFTER
const versionRow = database.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
  .get() as { version: number } | undefined
const currentVersion = versionRow?.version ?? 0
...
database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION)
```
```typescript
// BEFORE (runMigrations, line 1912)
getDatabase().run('INSERT OR REPLACE INTO schema_version (version) VALUES (?)', [v])
// AFTER
getDatabase().prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(v)
```

- [ ] **Step 7: Edit `saveDatabase`, `getDatabase`, `closeDatabase` (lines 2088–2101, 2148–2154)**
```typescript
// AFTER
export function saveDatabase(): void {
  // No-op: better-sqlite3 persists synchronously to disk (WAL). Retained so the
  // many existing callers across services keep compiling without edits.
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
```

- [ ] **Step 8: Edit `ensureDiarizationSchema` (lines 2111–2146)**

Change the two `database.run(\`CREATE ...\`)`/`database.run(\`CREATE INDEX ...\`)` to `database.exec(...)`, the `database.run('ALTER TABLE transcripts ...')` to `database.exec(...)`, and the PRAGMA read:
```typescript
// BEFORE
const tableInfo = database.exec("PRAGMA table_info(transcripts)")
const cols = tableInfo.length > 0 && tableInfo[0].values ? tableInfo[0].values.map((col) => col[1]) : []
// AFTER
const cols = (database.pragma('table_info(transcripts)') as Array<{ name: string }>).map(c => c.name)
```

- [ ] **Step 9: Edit the generic query helpers (lines 2191–2251)**
```typescript
// AFTER
export function queryAll<T>(sql: string, params: any[] = []): T[] {
  return getDatabase().prepare(sql).all(...params) as T[]
}

export function queryOne<T>(sql: string, params: any[] = []): T | undefined {
  return getDatabase().prepare(sql).get(...params) as T | undefined
}

export function run(sql: string, params: any[] = []): void {
  getDatabase().prepare(sql).run(...params)
}

// Retained for API compatibility. With better-sqlite3 there is no per-statement
// export/save, so this is identical to run(); callers inside runInTransaction()
// may keep using it.
export function runNoSave(sql: string, params: any[] = []): void {
  getDatabase().prepare(sql).run(...params)
}

export function runInTransaction<T>(fn: () => T): T {
  const database = getDatabase()
  database.exec('BEGIN')
  try {
    const result = fn()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function runMany(sql: string, items: any[][]): void {
  const database = getDatabase()
  const stmt = database.prepare(sql)
  const tx = database.transaction((rows: any[][]) => {
    for (const row of rows) stmt.run(...row)
  })
  tx(items)
}
```

- [ ] **Step 10: Edit the two inline prepared statements (~lines 3463 and 3533, `recording_window_embeddings`)**

Each block uses the sql.js prepare/bind/step/free pattern. Replace the pattern:
```typescript
// BEFORE (shape)
const stmt = getDatabase().prepare(`INSERT OR REPLACE INTO recording_window_embeddings ...`)
for (const row of rows) {
  stmt.bind([...]); stmt.step(); stmt.reset()
}
stmt.free()
// AFTER (shape)
const database = getDatabase()
const stmt = database.prepare(`INSERT OR REPLACE INTO recording_window_embeddings ...`)
const tx = database.transaction((items: Array<readonly unknown[]>) => {
  for (const args of items) stmt.run(...args)
})
tx(rows.map(row => [/* same positional values as the old bind([...]) */]))
```
Keep the exact column list and positional values from the original `bind([...])` calls.

- [ ] **Step 11: Run the boot test**

Run: `npx vitest run electron/main/services/__tests__/database.boot.test.ts`
Expected: PASS (4 tests). If a test fails on `undefined`/`boolean` binds, coerce at the failing call site (`?? null`, `? 1 : 0`).

- [ ] **Step 12: Commit**

```bash
git add electron/main/services/database.ts electron/main/services/__tests__/database.boot.test.ts
git commit -m "feat(0a): swap database.ts engine sql.js -> better-sqlite3"
```

---

### Task 5: Convert raw-handle call sites broken by the engine swap

`getDatabase()` now returns a better-sqlite3 handle whose `Statement` has no `.step()/.getAsObject()/.bind()/.free()`. Convert the call sites that use those, and fix `SqlJsDatabase` type references.

**Files (from `grep` of `.getAsObject(|.step(|.free(|SqlJsDatabase`):**
- Modify: `apps/electron/electron/main/ipc/migration-handlers.ts` (~20 sites)
- Modify: `apps/electron/electron/main/ipc/device-cache-handlers.ts` (~line 55)
- Modify: any file still importing `Database as SqlJsDatabase` / `SqlJsDatabase` type (re-run the grep to find the full set; `download-service.ts`, `rag.ts`, `transcript-export.ts`, `voiceprint/speaker-matcher.ts` matched the broader `sql.js` grep — most reference only the helper API and need no change beyond a type import swap if present).
- Test: existing suites (`__tests__/v11-migration.test.ts`, `__tests__/v11-migrate.test.ts`, handler tests) are the safety net.

**Interfaces:**
- Consumes: the better-sqlite3-backed `getDatabase()` (Task 4).

- [ ] **Step 1: Enumerate every raw-handle site**

Run:
```bash
grep -rnE "\.getAsObject\(|\.step\(\)|\.free\(\)|\.bind\(|SqlJsDatabase|import .*from 'sql\.js'" electron/main --include="*.ts" | grep -v "__tests__"
```
Expected: a finite list (database.ts is already converted; remaining hits are the files above). Record each.

- [ ] **Step 2: Apply the mechanical transformation to each site**

Single-row read:
```typescript
// BEFORE
const stmt = getDatabase().prepare(sql); stmt.bind(params); stmt.step()
const value = stmt.getAsObject().count as number; stmt.free()
// AFTER
const value = (getDatabase().prepare(sql).get(...params) as { count: number } | undefined)?.count ?? 0
```
Multi-row read:
```typescript
// BEFORE
const stmt = getDatabase().prepare(sql); while (stmt.step()) { const row = stmt.getAsObject(); ... }
stmt.free()
// AFTER
for (const row of getDatabase().prepare(sql).all(...params) as Array<Record<string, unknown>>) { ... }
```
Type import:
```typescript
// BEFORE
import type { Database as SqlJsDatabase } from 'sql.js'   // and SqlJsDatabase usages
// AFTER
import type Database from 'better-sqlite3'                // type is Database.Database
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no remaining references to sql.js types or `Statement.step/getAsObject/free`.

- [ ] **Step 4: Verify the grep is clean**

Run:
```bash
grep -rnE "\.getAsObject\(|\.step\(\)|\.free\(\)|import .*from 'sql\.js'" electron/main --include="*.ts" | grep -v "__tests__" || echo "clean"
```
Expected: `clean`.

- [ ] **Step 5: Run the affected suites**

Run: `npx vitest run electron/main/ipc electron/main/migrations electron/main/services`
Expected: PASS. Fix any `undefined`/`boolean` bind failures by coercing at the call site (`?? null`, `? 1 : 0`).

- [ ] **Step 6: Commit**

```bash
git add electron/main/ipc/migration-handlers.ts electron/main/ipc/device-cache-handlers.ts
git commit -m "feat(0a): convert raw sql.js handle call sites to better-sqlite3"
```
(Include any other files Step 1 surfaced.)

---

### Task 6: Headless boot entry + electron-import guard

**Files:**
- Create: `apps/electron/electron/main/boot-foundation.ts`
- Test: `apps/electron/electron/main/__tests__/headless-foundation.test.ts`

**Interfaces:**
- Consumes: `initializeConfig` (config), `initializeFileStorage` (file-storage), `initializeDatabase`/`closeDatabase` (database).
- Produces: `bootFoundation(): Promise<void>` — the ordered headless boot used by later sub-plans' server entry.

- [ ] **Step 1: Write the failing test**

Create `electron/main/__tests__/headless-foundation.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('headless foundation', () => {
  let dir: string
  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'hidock-boot-'))
    process.env.HIDOCK_DATA_ROOT = dir
  })
  afterEach(async () => {
    const { closeDatabase } = await import('../services/database')
    try { closeDatabase() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
    delete process.env.HIDOCK_DATA_ROOT
  })

  it('boots config + storage + db with no electron dependency', async () => {
    const { bootFoundation } = await import('../boot-foundation')
    await bootFoundation()
    const { queryOne } = await import('../services/database')
    expect(queryOne<{ version: number }>('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')?.version).toBe(33)
  })

  it('foundation modules contain no `from \'electron\'` import', () => {
    for (const f of ['services/config.ts', 'services/file-storage.ts', 'services/database.ts', 'runtime/env.ts', 'runtime/secrets.ts']) {
      const src = readFileSync(join(__dirname, '..', f), 'utf-8')
      expect(src, `${f} must not import electron`).not.toMatch(/from ['"]electron['"]/)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/main/__tests__/headless-foundation.test.ts`
Expected: FAIL — cannot find module `../boot-foundation`.

- [ ] **Step 3: Write the boot entry**

Create `electron/main/boot-foundation.ts`:
```typescript
import { initializeConfig } from './services/config'
import { initializeFileStorage } from './services/file-storage'
import { initializeDatabase } from './services/database'

/**
 * Headless boot of the data foundation, in dependency order:
 * config (paths/secrets) → file storage (dirs) → database (better-sqlite3, schema v33).
 * Used by the Fastify server entry in sub-plan 0b. No Electron.
 */
export async function bootFoundation(): Promise<void> {
  await initializeConfig()
  await initializeFileStorage()
  await initializeDatabase()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/main/__tests__/headless-foundation.test.ts`
Expected: PASS (2 tests). If the guard test fails, an Electron import remains in a foundation module — remove it.

- [ ] **Step 5: Full suite + typecheck gate**

Run: `npm run typecheck && npm run test:run`
Expected: PASS. (Catches any service still depending on sql.js export semantics or raw-handle binds.)

- [ ] **Step 6: Commit**

```bash
git add electron/main/boot-foundation.ts electron/main/__tests__/headless-foundation.test.ts
git commit -m "feat(0a): headless foundation boot entry + electron-import guard"
```

---

## Plan series roadmap (0b–0f)

0a is the bedrock. The remaining Phase 0 sub-plans, each its own document and dependent on 0a:

- **0b — Fastify server + Google OIDC + invite system.** `bootFoundation()` → Fastify app; session; `allowed_users` table (new migration v34); `openid-client` Google flow; `ADMIN_EMAIL` bootstrap; admin user routes guarded by role; `/healthz`.
- **0c — REST routers + WS broadcaster.** Define a `Broadcaster` interface and a WS implementation; replace the 5 `webContents.send` sites (`event-bus`, `recording-watcher`, `transcription`, `download-service`, `activity-log`) with it. Port `ipc/*-handlers.ts` → REST routers calling existing services.
- **0d — Media range endpoint.** Authed `GET /api/recordings/:id/media` with HTTP range, replacing `hidock-media://` + `media-protocol.ts`.
- **0e — Renderer: facade→SDK + Electron-ism removal.** Reimplement the `callIPC` chokepoint + `ipcRenderer.on` events over REST/WS; add the "Connect device" gesture stub; strip window chrome, native dialogs, `shell.openExternal`.
- **0f — Docker + Unraid + NPM.** Multi-stage image (SPA + server + native deps), `/data` volume, NPM TLS + WebSocket passthrough.

---

## Self-Review

**Spec coverage (Phase 0 / data-layer slice):** §8 DB engine → Tasks 4–5; §8 relative paths / fresh start → runtime data root (Task 1) + config default (Task 3); §4 "services lift, replace `setMainWindow`" foundation prerequisite → de-Electron config/db (Tasks 3–4); Risk A (sql.js concurrency) → Task 4 (WAL); the broadcaster/REST/auth/media/docker items are explicitly scoped to 0b–0f in the roadmap.

**Placeholder scan:** No "TBD/TODO". The one non-inlined body is the 32-migration / multi-site conversion in Task 5, specified as an explicit mechanical transformation (exact before/after for each pattern) gated by `grep`-clean + `typecheck` + full suite — not a placeholder.

**Type consistency:** `getDatabase()` returns `Database.Database` consistently (Tasks 4, 5). Helper signatures (`queryAll`/`queryOne`/`run`/`runNoSave`/`runInTransaction`/`runMany`) match the Global Constraints block and Task 4 implementations. `encryptSensitive`/`decryptSensitive` signatures match between Task 2 (definition) and Task 3 (consumption). `getDataRoot`/`getConfigPath` match between Task 1 and Task 3.
