# Voice Library Foundation (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the validated, low-risk foundation of the voice-library system — swap the speaker-embedding model to ERes2Net, add the storage (a v27 migration: per-label embeddings, suggestions, voiceprint provenance, the `recording_speakers.source` CHECK rebuild, `is_self`), and move embedding off the main thread into a `utilityProcess` so every label of a recording can be embedded without freezing the UI.

**Architecture:** All changes are main-process + DB. The model swap is config-only (256-dim → no embedding-storage migration). The embedding compute moves out of the main process into a `utilityProcess` child that loads `sherpa-onnx-node`; the main process sends decoded PCM + turns and receives a 256-dim BLOB. New DB helpers + a v27 migration add the storage the later phases (suggestions/matching) build on. No UI and no auto-apply in this phase.

**Tech Stack:** Electron 39 main process (TypeScript, CJS bundle via electron-vite), `sherpa-onnx-node@1.13.3` (native NAPI addon, `compute(stream, false)`), `3d-speaker ERes2Net` ONNX (256-dim), sql.js (SQLite), Vitest. All tests mock the native addon and `child_process`; no real hardware/USB/network.

**Scope note (per writing-plans scope-check):** This is **Phase 1** of rev-2 (`docs/superpowers/specs/2026-06-19-voice-library-speaker-identity-design.md`). Phase 2 (manual identity assignment UX, conservative banking hygiene, the disable-recognition privacy toggle + per-contact delete UI) is a **follow-on plan** — the DB primitives it needs (`deleteVoiceprint`, provenance columns, `is_self`, `privacy` config) are built here so Phase 2 is pure wiring. Phases 3–7 (suggestion UX, static floor, backstop, research-gated probe/auto-apply) are later plans.

**Quality gate (run from `apps/electron` after each task):** `npm run typecheck && npm run lint && npm run test:run`

---

## File Structure

All paths relative to `apps/electron/`.

**Modify:**
- `electron/main/services/voiceprint-service.ts` — change `VOICEPRINT_MODEL_ID` to ERes2Net; route `compute()` through the new worker pool; raise/stream the PCM cap; add `embedRecordingLabels()`.
- `scripts/fetch-models.mjs` — add the ERes2Net model entry (replaces WeSpeaker).
- `electron-builder.yml` — bundle the ERes2Net `.onnx` (asarUnpack + extraResources).
- `electron/main/services/database.ts` — bump `SCHEMA_VERSION` to 27; add the v27 migration + the new tables to fresh `SCHEMA`; add the DB helpers (`insertLabelEmbedding`/`getLabelEmbeddingsForRecording`/`deleteLabelEmbeddingsForRecording`, `insertSuggestion`/`dismissSuggestion`/`getPendingSuggestions`, `deleteVoiceprint`/`disableVoiceprint`, `getActiveVoiceprintsByContactId`, `getSelfContactId`/`setSelfContact`).
- `electron.vite.config.ts` — add the voiceprint worker as a second `main` build input.
- `electron/main/services/config.ts` — add the `privacy` section (so Phase 2's toggle has a home) — schema only.

**Create:**
- `electron/main/workers/voiceprint-worker.ts` — a `utilityProcess` entry that loads sherpa and computes embeddings from messages.
- `electron/main/services/voiceprint-worker-pool.ts` — lazy-spawn / restart / request-response wrapper around the child.
- `electron/main/services/__tests__/voiceprint-worker-pool.test.ts`, `database-v27.test.ts`, plus additions to existing `voiceprint-service.test.ts`.

---

## Task 1: Swap the embedding model to ERes2Net

**Files:**
- Modify: `electron/main/services/voiceprint-service.ts:72` (`VOICEPRINT_MODEL_ID`)
- Modify: `scripts/fetch-models.mjs:33-44` (MODELS array)
- Modify: `electron-builder.yml:12-20` (asarUnpack + extraResources)
- Test: `electron/main/services/__tests__/voiceprint-service.test.ts`

- [ ] **Step 1: Write the failing test** — assert the model id is the ERes2Net one (so stored `voiceprints.model_id` reflects it). Add to `voiceprint-service.test.ts`:

```typescript
import { VOICEPRINT_MODEL_ID } from '../voiceprint-service'

it('uses the ERes2Net model id (not the retired WeSpeaker)', () => {
  expect(VOICEPRINT_MODEL_ID).toBe('3dspeaker_eres2net_en_voxceleb')
  expect(VOICEPRINT_MODEL_ID).not.toMatch(/wespeaker/i)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run electron/main/services/__tests__/voiceprint-service.test.ts -t "ERes2Net model id"`
Expected: FAIL — current id is `wespeaker_en_voxceleb_resnet34_LM`.

- [ ] **Step 3: Change the model id.** In `voiceprint-service.ts` line 72:

```typescript
// ERes2Net (3D-Speaker, en VoxCeleb, 16k) — adopted rev 2 (Phase-0: ~0.8% cross-recording
// EER on real far-field P1 audio vs WeSpeaker's 26.8%). 256-dim → no voiceprints storage
// migration. Per-voiceprint model_id makes a future swap re-embeddable.
export const VOICEPRINT_MODEL_ID = '3dspeaker_eres2net_en_voxceleb'
```

- [ ] **Step 4: Update the model fetcher.** In `scripts/fetch-models.mjs`, replace the MODELS array entry:

```javascript
const MODELS = [
  {
    name: '3dspeaker_eres2net_en_voxceleb.onnx',
    // 3D-Speaker ERes2Net (en VoxCeleb 16k) from the k2-fsa/sherpa-onnx release tag
    // "speaker-recongition-models" (upstream's real misspelling). Adopted rev 2.
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx',
    // sha256 null = not pinned yet: models:fetch prints the computed hash to paste here.
    // (The HTTP 200 of this URL was verified in the Phase-0 model trial; ~26.5 MB.)
    sha256: null,
  },
]
```

Note: the upstream asset filename (`3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx`) differs from our local `name` (`3dspeaker_eres2net_en_voxceleb.onnx`); `name` is what we save to and what `VOICEPRINT_MODEL_ID` + the builder config reference. If the URL 404s, HEAD-verify the exact asset name in that release and correct the `url`.

- [ ] **Step 5: Update electron-builder bundling.** In `electron-builder.yml`, replace the two WeSpeaker references:

```yaml
asarUnpack:
  - '**/*.node'
  - '**/usb/**'
  - '**/ffmpeg-static/**'
  - '**/sherpa-onnx-node/**'
  - 'resources/models/3dspeaker_eres2net_en_voxceleb.onnx'
extraResources:
  - from: resources/models/3dspeaker_eres2net_en_voxceleb.onnx
    to: models/3dspeaker_eres2net_en_voxceleb.onnx
```

- [ ] **Step 6: Fetch + pin the SHA.** Run `npm run models:fetch`; it downloads and prints the SHA-256. Paste that hash + confirm the byte size into the `sha256` field in `fetch-models.mjs`, then re-run `npm run models:fetch` and confirm it prints `verified … (sha256 ok)`.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run electron/main/services/__tests__/voiceprint-service.test.ts`
Expected: PASS (all voiceprint tests — they mock sherpa via `Module._load`, so they're model-agnostic; the new id assertion passes).

- [ ] **Step 8: Commit**

```bash
git add apps/electron/electron/main/services/voiceprint-service.ts apps/electron/scripts/fetch-models.mjs apps/electron/electron-builder.yml apps/electron/electron/main/services/__tests__/voiceprint-service.test.ts
git commit -m "feat(electron): swap voiceprint model to ERes2Net (Phase-0 validated)"
```

---

## Task 2: v27 migration — new tables, voiceprint provenance, source CHECK rebuild, is_self

**Files:**
- Modify: `electron/main/services/database.ts:11` (`SCHEMA_VERSION`), the fresh `SCHEMA` block (~263-282 + contacts ~396-410), and the `MIGRATIONS` map (~1436)
- Test: `electron/main/services/__tests__/database-v27.test.ts` (new)

- [ ] **Step 1: Write the failing test.** Create `database-v27.test.ts` mirroring the v26 test setup (hoisted `shared` tmpdir + `vi.mock('electron'|'../config'|'../file-storage'|'../vector-store')` exactly as in `database-v26.test.ts:19-77`). Then:

```typescript
import { initializeDatabase, closeDatabase, run, queryOne, queryAll } from '../database'

beforeEach(async () => {
  fs.mkdirSync(shared.dataDir, { recursive: true })
  if (fs.existsSync(shared.dbPath)) fs.rmSync(shared.dbPath)
  await initializeDatabase()
})
afterEach(() => { try { closeDatabase() } catch { /* ignore */ } })

describe('v27 voice-library foundation schema', () => {
  it('schema_version is 27', () => {
    expect(queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')!.version).toBe(27)
  })
  it('recording_label_embeddings table exists with the expected columns', () => {
    run(`INSERT INTO recording_label_embeddings
      (id, recording_id, transcript_id, diarization_run_id, file_label, model_id, model_version, dim, embedding, clean_speech_ms, turn_count, quality_score, status, created_at)
      VALUES ('le1','r1','t1','run1','A','3dspeaker_eres2net_en_voxceleb',1,256,?,12000,5,0.9,'ok',?)`,
      [new Uint8Array(1024), new Date().toISOString()])
    expect(queryAll('SELECT * FROM recording_label_embeddings').length).toBe(1)
  })
  it('speaker_suggestions table exists', () => {
    run(`INSERT INTO speaker_suggestions (id, recording_id, transcript_id, kind, target_label, contact_id, score, rank, status, created_at)
         VALUES ('s1','r1','t1','identity','A','c1',0.7,0,'pending',?)`, [new Date().toISOString()])
    expect(queryAll("SELECT * FROM speaker_suggestions WHERE status='pending'").length).toBe(1)
  })
  it('voiceprints has provenance columns and accepts a disabled/superseded print', () => {
    run(`INSERT INTO contacts (id, name, first_seen_at, last_seen_at) VALUES ('c1','X',?,?)`, [new Date().toISOString(), new Date().toISOString()])
    run(`INSERT INTO voiceprints (id, contact_id, model_id, dim, embedding, created_at, source_recording_id, source_label, clean_speech_ms, quality_score, model_version, created_from)
         VALUES ('vp1','c1','3dspeaker_eres2net_en_voxceleb',256,?,?, 'r1','A',12000,0.9,1,'manual')`, [new Uint8Array(1024), new Date().toISOString()])
    run(`UPDATE voiceprints SET disabled_at=? WHERE id='vp1'`, [new Date().toISOString()])
    expect(queryOne<{ disabled_at: string }>("SELECT disabled_at FROM voiceprints WHERE id='vp1'")!.disabled_at).toBeTruthy()
  })
  it("recording_speakers.source now accepts 'confirmed' and 'self_auto' (CHECK rebuilt)", () => {
    expect(() => run(`INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at) VALUES ('r1','A','c1','confirmed',?)`, [new Date().toISOString()])).not.toThrow()
    expect(() => run(`INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at) VALUES ('r1','B','c1','self_auto',?)`, [new Date().toISOString()])).not.toThrow()
    expect(() => run(`INSERT INTO recording_speakers (recording_id, file_label, contact_id, source, created_at) VALUES ('r1','C','c1','robot',?)`, [new Date().toISOString()])).toThrow(/CHECK|constraint/i)
  })
  it('contacts has is_self', () => {
    run(`INSERT INTO contacts (id, name, is_self, first_seen_at, last_seen_at) VALUES ('me','Me',1,?,?)`, [new Date().toISOString(), new Date().toISOString()])
    expect(queryOne<{ is_self: number }>("SELECT is_self FROM contacts WHERE id='me'")!.is_self).toBe(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run electron/main/services/__tests__/database-v27.test.ts`
Expected: FAIL — `schema_version` is 26; the new tables/columns don't exist; the CHECK still rejects `confirmed`.

- [ ] **Step 3: Bump the version + add the fresh-schema tables.** In `database.ts`: change line 11 to `const SCHEMA_VERSION = 27`. Update the **fresh** `recording_speakers` CREATE (the SCHEMA const ~263-272) so new DBs get the wider CHECK directly:

```sql
CREATE TABLE IF NOT EXISTS recording_speakers (
    recording_id TEXT NOT NULL,
    file_label TEXT NOT NULL,
    contact_id TEXT,
    confidence REAL,
    source TEXT NOT NULL CHECK(source IN ('user', 'auto', 'confirmed', 'self_auto', 'suggestion_confirmed')) DEFAULT 'user',
    created_at TEXT NOT NULL,
    PRIMARY KEY (recording_id, file_label)
)
```

Update the fresh `voiceprints` CREATE (~274-282) to include provenance columns:

```sql
CREATE TABLE IF NOT EXISTS voiceprints (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    dim INTEGER NOT NULL,
    embedding BLOB NOT NULL,
    created_at TEXT NOT NULL,
    source_recording_id TEXT,
    source_label TEXT,
    clean_speech_ms INTEGER,
    quality_score REAL,
    model_version INTEGER DEFAULT 1,
    created_from TEXT CHECK(created_from IN ('manual','confirmed','self','import')) DEFAULT 'manual',
    disabled_at TEXT,
    superseded_by TEXT
)
```

Add `is_self INTEGER NOT NULL DEFAULT 0` to the fresh `contacts` CREATE (~396-410, after `meeting_count`). And add two new fresh tables in the SCHEMA block:

```sql
CREATE TABLE IF NOT EXISTS recording_label_embeddings (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL,
    transcript_id TEXT,
    diarization_run_id TEXT,
    file_label TEXT NOT NULL,
    model_id TEXT NOT NULL,
    model_version INTEGER DEFAULT 1,
    dim INTEGER NOT NULL,
    embedding BLOB NOT NULL,
    clean_speech_ms INTEGER,
    turn_count INTEGER,
    quality_score REAL,
    status TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
)
```
```sql
CREATE TABLE IF NOT EXISTS speaker_suggestions (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL,
    transcript_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('identity','merge','mixed','backstop')),
    target_label TEXT,
    target_label_2 TEXT,
    contact_id TEXT,
    score REAL,
    rank INTEGER,
    rationale TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending','accepted','dismissed','expired')) DEFAULT 'pending',
    created_at TEXT NOT NULL,
    resolved_at TEXT
)
```

- [ ] **Step 4: Add the v27 migration.** Add `27: () => {...}` to the `MIGRATIONS` map (after the v26 entry, ~1485), following the v26 column-add pattern and the v24 table-rebuild pattern:

```javascript
27: () => {
  // v27: voice-library foundation (spec 2026-06-19 rev 2 §8). New tables, voiceprint
  // provenance columns, recording_speakers.source CHECK widened (table-rebuild — sql.js
  // can't ALTER a CHECK), and contacts.is_self.
  console.log('Running migration to schema v27: voice-library foundation')
  const database = getDatabase()

  // (a) idempotent column adds (duplicate-column expected on a fresh v27 DB)
  const columnsToAdd = [
    'ALTER TABLE voiceprints ADD COLUMN source_recording_id TEXT',
    'ALTER TABLE voiceprints ADD COLUMN source_label TEXT',
    'ALTER TABLE voiceprints ADD COLUMN clean_speech_ms INTEGER',
    'ALTER TABLE voiceprints ADD COLUMN quality_score REAL',
    'ALTER TABLE voiceprints ADD COLUMN model_version INTEGER DEFAULT 1',
    "ALTER TABLE voiceprints ADD COLUMN created_from TEXT DEFAULT 'manual'",
    'ALTER TABLE voiceprints ADD COLUMN disabled_at TEXT',
    'ALTER TABLE voiceprints ADD COLUMN superseded_by TEXT',
    'ALTER TABLE contacts ADD COLUMN is_self INTEGER NOT NULL DEFAULT 0'
  ]
  for (const sql of columnsToAdd) {
    try { database.run(sql) } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('duplicate column name')) console.log(`Column already exists: ${sql}`)
      else console.warn(`[Migration v27] ALTER failed (${sql}):`, e)
    }
  }

  // (b) new tables (idempotent)
  database.run(`CREATE TABLE IF NOT EXISTS recording_label_embeddings (
    id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, transcript_id TEXT, diarization_run_id TEXT,
    file_label TEXT NOT NULL, model_id TEXT NOT NULL, model_version INTEGER DEFAULT 1, dim INTEGER NOT NULL,
    embedding BLOB NOT NULL, clean_speech_ms INTEGER, turn_count INTEGER, quality_score REAL, status TEXT,
    created_at TEXT NOT NULL, updated_at TEXT)`)
  database.run(`CREATE TABLE IF NOT EXISTS speaker_suggestions (
    id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, transcript_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('identity','merge','mixed','backstop')),
    target_label TEXT, target_label_2 TEXT, contact_id TEXT, score REAL, rank INTEGER, rationale TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending','accepted','dismissed','expired')) DEFAULT 'pending',
    created_at TEXT NOT NULL, resolved_at TEXT)`)

  // (c) recording_speakers.source CHECK rebuild (sql.js can't ALTER a CHECK — table-rebuild, cf. MIGRATIONS[24])
  database.run(`CREATE TABLE IF NOT EXISTS recording_speakers_new (
    recording_id TEXT NOT NULL, file_label TEXT NOT NULL, contact_id TEXT, confidence REAL,
    source TEXT NOT NULL CHECK(source IN ('user','auto','confirmed','self_auto','suggestion_confirmed')) DEFAULT 'user',
    created_at TEXT NOT NULL, PRIMARY KEY (recording_id, file_label))`)
  database.run(`INSERT OR IGNORE INTO recording_speakers_new
    SELECT recording_id, file_label, contact_id, confidence, source, created_at FROM recording_speakers`)
  database.run('DROP TABLE IF EXISTS recording_speakers')
  database.run('ALTER TABLE recording_speakers_new RENAME TO recording_speakers')

  console.log('Migration v27 complete')
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run electron/main/services/__tests__/database-v27.test.ts`
Expected: PASS — version 27, both new tables, provenance columns, the widened CHECK accepts `confirmed`/`self_auto` and rejects `robot`, `is_self` present.

- [ ] **Step 6: Commit**

```bash
git add apps/electron/electron/main/services/database.ts apps/electron/electron/main/services/__tests__/database-v27.test.ts
git commit -m "feat(electron): v27 migration — label embeddings, suggestions, voiceprint provenance, source rebuild, is_self"
```

---

## Task 3: DB helpers for the new tables + voiceprint hygiene primitives

**Files:**
- Modify: `electron/main/services/database.ts` (add exported functions near `insertVoiceprint` ~2769)
- Test: add to `database-v27.test.ts`

- [ ] **Step 1: Write the failing test.** Add to `database-v27.test.ts`:

```typescript
import {
  insertLabelEmbedding, getLabelEmbeddingsForRecording, deleteLabelEmbeddingsForRecording,
  insertSuggestion, dismissSuggestion, getPendingSuggestions,
  insertVoiceprint, getActiveVoiceprintsByContactId, deleteVoiceprint, disableVoiceprint,
  setSelfContact, getSelfContactId
} from '../database'

describe('v27 DB helpers', () => {
  it('label embedding insert/get/delete round-trips', () => {
    insertLabelEmbedding({ id: 'le1', recording_id: 'r1', transcript_id: 't1', diarization_run_id: 'run1', file_label: 'A', model_id: 'm', model_version: 1, dim: 256, embedding: new Uint8Array(1024), clean_speech_ms: 12000, turn_count: 4, quality_score: 0.9, status: 'ok' })
    expect(getLabelEmbeddingsForRecording('r1')).toHaveLength(1)
    deleteLabelEmbeddingsForRecording('r1')
    expect(getLabelEmbeddingsForRecording('r1')).toHaveLength(0)
  })
  it('suggestions: insert, list pending, dismiss removes from pending', () => {
    insertSuggestion({ id: 's1', recording_id: 'r1', transcript_id: 't1', kind: 'identity', target_label: 'A', contact_id: 'c1', score: 0.7, rank: 0 })
    expect(getPendingSuggestions('r1')).toHaveLength(1)
    dismissSuggestion('s1')
    expect(getPendingSuggestions('r1')).toHaveLength(0)
  })
  it('voiceprint: active query excludes disabled; delete removes; disable hides', () => {
    run(`INSERT INTO contacts (id, name, first_seen_at, last_seen_at) VALUES ('c1','X',?,?)`, [new Date().toISOString(), new Date().toISOString()])
    insertVoiceprint({ id: 'vp1', contact_id: 'c1', model_id: 'm', dim: 256, embedding: new Uint8Array(1024) })
    insertVoiceprint({ id: 'vp2', contact_id: 'c1', model_id: 'm', dim: 256, embedding: new Uint8Array(1024) })
    expect(getActiveVoiceprintsByContactId('c1')).toHaveLength(2)
    disableVoiceprint('vp1')
    expect(getActiveVoiceprintsByContactId('c1')).toHaveLength(1)
    deleteVoiceprint('vp2')
    expect(getActiveVoiceprintsByContactId('c1')).toHaveLength(0)
  })
  it('self contact is a singleton', () => {
    run(`INSERT INTO contacts (id, name, first_seen_at, last_seen_at) VALUES ('a','A',?,?),('b','B',?,?)`, [new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), new Date().toISOString()])
    setSelfContact('a'); expect(getSelfContactId()).toBe('a')
    setSelfContact('b'); expect(getSelfContactId()).toBe('b') // moves; only one self
    expect(queryAll('SELECT id FROM contacts WHERE is_self=1')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run electron/main/services/__tests__/database-v27.test.ts -t "v27 DB helpers"`
Expected: FAIL — the helper functions are not exported.

- [ ] **Step 3: Implement the helpers.** Add to `database.ts` (near `insertVoiceprint`). Reuse the existing `run`/`queryAll`/`queryOne` and the `Omit<...,'created_at'>` + ISO-stamp pattern:

```typescript
export interface LabelEmbedding {
  id: string; recording_id: string; transcript_id?: string | null; diarization_run_id?: string | null
  file_label: string; model_id: string; model_version?: number; dim: number; embedding: Uint8Array
  clean_speech_ms?: number | null; turn_count?: number | null; quality_score?: number | null; status?: string | null
}
export function insertLabelEmbedding(e: LabelEmbedding): void {
  run(`INSERT OR REPLACE INTO recording_label_embeddings
    (id, recording_id, transcript_id, diarization_run_id, file_label, model_id, model_version, dim, embedding, clean_speech_ms, turn_count, quality_score, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [e.id, e.recording_id, e.transcript_id ?? null, e.diarization_run_id ?? null, e.file_label, e.model_id, e.model_version ?? 1, e.dim, e.embedding, e.clean_speech_ms ?? null, e.turn_count ?? null, e.quality_score ?? null, e.status ?? null, new Date().toISOString()])
}
export function getLabelEmbeddingsForRecording(recordingId: string): LabelEmbedding[] {
  return queryAll<LabelEmbedding>('SELECT * FROM recording_label_embeddings WHERE recording_id = ?', [recordingId])
}
export function deleteLabelEmbeddingsForRecording(recordingId: string): void {
  run('DELETE FROM recording_label_embeddings WHERE recording_id = ?', [recordingId])
}

export interface SpeakerSuggestion {
  id: string; recording_id: string; transcript_id?: string | null; kind: 'identity' | 'merge' | 'mixed' | 'backstop'
  target_label?: string | null; target_label_2?: string | null; contact_id?: string | null
  score?: number | null; rank?: number | null; rationale?: string | null
}
export function insertSuggestion(s: SpeakerSuggestion): void {
  run(`INSERT OR REPLACE INTO speaker_suggestions
    (id, recording_id, transcript_id, kind, target_label, target_label_2, contact_id, score, rank, rationale, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?)`,
    [s.id, s.recording_id, s.transcript_id ?? null, s.kind, s.target_label ?? null, s.target_label_2 ?? null, s.contact_id ?? null, s.score ?? null, s.rank ?? null, s.rationale ?? null, new Date().toISOString()])
}
export function dismissSuggestion(id: string): void {
  run("UPDATE speaker_suggestions SET status='dismissed', resolved_at=? WHERE id=?", [new Date().toISOString(), id])
}
export function getPendingSuggestions(recordingId: string): SpeakerSuggestion[] {
  return queryAll<SpeakerSuggestion>("SELECT * FROM speaker_suggestions WHERE recording_id=? AND status='pending' ORDER BY rank", [recordingId])
}

export function getActiveVoiceprintsByContactId(contactId: string): Voiceprint[] {
  return queryAll<Voiceprint>('SELECT * FROM voiceprints WHERE contact_id=? AND disabled_at IS NULL ORDER BY created_at', [contactId])
}
export function disableVoiceprint(id: string): void {
  run('UPDATE voiceprints SET disabled_at=? WHERE id=?', [new Date().toISOString(), id])
}
export function deleteVoiceprint(id: string): void {
  run('DELETE FROM voiceprints WHERE id=?', [id])
}

export function getSelfContactId(): string | null {
  return queryOne<{ id: string }>('SELECT id FROM contacts WHERE is_self=1 LIMIT 1')?.id ?? null
}
export function setSelfContact(contactId: string): void {
  runInTransaction(() => {
    runNoSave('UPDATE contacts SET is_self=0 WHERE is_self=1')
    runNoSave('UPDATE contacts SET is_self=1 WHERE id=?', [contactId])
  })
}
```

(Note: `runInTransaction`/`runNoSave` already exist — see `database.ts:1745` — use them so the two writes save once and `is_self` stays a singleton.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run electron/main/services/__tests__/database-v27.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/electron/electron/main/services/database.ts apps/electron/electron/main/services/__tests__/database-v27.test.ts
git commit -m "feat(electron): v27 DB helpers — label embeddings, suggestions, voiceprint hygiene (delete/disable), self contact"
```

---

## Task 4: Off-thread embedding via `utilityProcess` (+ PCM-cap fix)

**Files:**
- Create: `electron/main/workers/voiceprint-worker.ts`
- Create: `electron/main/services/voiceprint-worker-pool.ts`
- Modify: `electron.vite.config.ts` (add the worker as a second `main` input)
- Modify: `electron/main/services/voiceprint-service.ts` (route compute through the pool; raise the PCM cap)
- Test: `electron/main/services/__tests__/voiceprint-worker-pool.test.ts` (new)

- [ ] **Step 1: Write the worker (`voiceprint-worker.ts`).** A `utilityProcess` child: loads sherpa once, embeds on request, replies via `process.parentPort`. (No DB, no Electron app APIs — pure compute.)

```typescript
// utilityProcess child: isolates the native sherpa addon off the main process so the
// synchronous embedding compute never blocks the UI. Receives { id, modelPath, sampleRate,
// samples (Float32Array, transferred) } and replies { id, ok, embedding? , error? }.
import process from 'node:process'

// eslint-disable-next-line @typescript-eslint/no-require-imports
let sherpa: any = null
const extractors = new Map<string, any>() // modelPath -> extractor

function getExtractor(modelPath: string) {
  if (!sherpa) sherpa = require('sherpa-onnx-node')
  let ext = extractors.get(modelPath)
  if (!ext) {
    ext = new sherpa.SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 1, debug: false })
    extractors.set(modelPath, ext)
  }
  return ext
}

process.parentPort.on('message', (e: { data: { id: string; modelPath: string; sampleRate: number; samples: Float32Array } }) => {
  const { id, modelPath, sampleRate, samples } = e.data
  try {
    const ext = getExtractor(modelPath)
    const stream = ext.createStream()
    stream.acceptWaveform({ sampleRate, samples })
    stream.inputFinished()
    if (!ext.isReady(stream)) { process.parentPort.postMessage({ id, ok: false, error: 'extractor not ready' }); return }
    const emb = new Float32Array(ext.compute(stream, false)) // V8-owned copy
    process.parentPort.postMessage({ id, ok: true, dim: ext.dim, embedding: emb }, [emb.buffer])
  } catch (err) {
    process.parentPort.postMessage({ id, ok: false, error: (err as Error).message })
  }
})
```

- [ ] **Step 2: Bundle the worker.** In `electron.vite.config.ts`, add it as a second `main` input so electron-vite emits `out/main/voiceprint-worker.js`:

```typescript
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main/index.ts'),
          'voiceprint-worker': resolve(__dirname, 'electron/main/workers/voiceprint-worker.ts')
        }
      }
    }
  },
```

- [ ] **Step 3: Write the failing pool test (`voiceprint-worker-pool.test.ts`).** Mock `electron`'s `utilityProcess` with a fake child that echoes a deterministic embedding, and assert the pool resolves a request:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

const fakeChild = new EventEmitter() as any
fakeChild.postMessage = (msg: any) => {
  // echo back a fake embedding on the next tick, keyed by id
  setImmediate(() => fakeChild.emit('message', { data: { id: msg.id, ok: true, dim: 256, embedding: new Float32Array(256).fill(0.1) } }))
}
vi.mock('electron', () => ({
  utilityProcess: { fork: vi.fn(() => fakeChild) },
  app: { isPackaged: false, getAppPath: () => '/fake/app' }
}))

import { embedSamples, shutdownVoiceprintPool } from '../voiceprint-worker-pool'

beforeEach(() => { shutdownVoiceprintPool() })

describe('voiceprint worker pool', () => {
  it('forks a child and resolves an embedding', async () => {
    const emb = await embedSamples('/fake/app/model.onnx', 16000, new Float32Array(16000))
    expect(emb).toBeInstanceOf(Float32Array)
    expect(emb!.length).toBe(256)
  })
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run electron/main/services/__tests__/voiceprint-worker-pool.test.ts`
Expected: FAIL — `voiceprint-worker-pool` does not exist.

- [ ] **Step 5: Implement the pool (`voiceprint-worker-pool.ts`).** Lazy-spawn one child, route request/response by id, restart on exit:

```typescript
import { utilityProcess, app } from 'electron'
import { join } from 'path'

type Pending = { resolve: (v: Float32Array | null) => void }
let child: ReturnType<typeof utilityProcess.fork> | null = null
const pending = new Map<string, Pending>()
let seq = 0

function workerPath(): string {
  // electron-vite emits the worker next to the main bundle (out/main/voiceprint-worker.js).
  return join(app.getAppPath(), 'out', 'main', 'voiceprint-worker.js')
}

function ensureChild() {
  if (child) return child
  child = utilityProcess.fork(workerPath())
  child.on('message', (m: { id: string; ok: boolean; embedding?: Float32Array }) => {
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    p.resolve(m.ok && m.embedding ? new Float32Array(m.embedding) : null)
  })
  child.on('exit', () => {
    for (const p of pending.values()) p.resolve(null)
    pending.clear()
    child = null // next call re-spawns
  })
  return child
}

/** Embed samples off the main thread. Resolves null on any failure (never throws). */
export function embedSamples(modelPath: string, sampleRate: number, samples: Float32Array): Promise<Float32Array | null> {
  return new Promise((resolve) => {
    try {
      const c = ensureChild()
      const id = `vp_${++seq}`
      pending.set(id, { resolve })
      c.postMessage({ id, modelPath, sampleRate, samples }, [samples.buffer])
    } catch {
      resolve(null)
    }
  })
}

export function shutdownVoiceprintPool(): void {
  if (child) { try { child.kill() } catch { /* ignore */ } child = null }
  for (const p of pending.values()) p.resolve(null)
  pending.clear()
}
```

- [ ] **Step 6: Route `captureVoiceprint` through the pool + raise the PCM cap.** In `voiceprint-service.ts`: (a) raise `PCM_MAX_BUFFER` so long recordings aren't rejected:

```typescript
const PCM_MAX_BUFFER = 2 * 1024 * 1024 * 1024 // 2 GB: a ~2.3h cap silently dropped long Service recordings
```

(b) replace the in-process `ext.compute()` block in `captureVoiceprint` (lines ~256-274) with a pool call. Resolve the model path the same way `getExtractor` does, and keep `isVoiceprintAvailable()` (the require gate) as the availability check:

```typescript
import { embedSamples } from './voiceprint-worker-pool'

function modelPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'models', `${VOICEPRINT_MODEL_ID}.onnx`)
    : join(app.getAppPath(), 'resources', 'models', `${VOICEPRINT_MODEL_ID}.onnx`)
}

// ...inside captureVoiceprint, after `const samples = pcmToFloat32(...)`:
  const embedding = await embedSamples(modelPath(), 16000, samples)
  if (!embedding) return { captured: false, reason: 'embedding failed (worker)' }
  insertVoiceprint({
    id: `vp_${randomUUID()}`,
    contact_id: contactId,
    model_id: VOICEPRINT_MODEL_ID,
    dim: embedding.length,
    embedding: embeddingToBlob(embedding),
  })
  return { captured: true }
```

(The in-process `getExtractor`/`SherpaModule`/sherpa-`require` can stay only as `isVoiceprintAvailable()`'s probe, or be removed in Phase 2 cleanup — out of scope here. Existing `voiceprint-service.test.ts` capture tests that asserted the in-process `compute` path must be updated to mock `./voiceprint-worker-pool`'s `embedSamples` instead; do that in this step so the suite stays green.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run electron/main/services/__tests__/voiceprint-worker-pool.test.ts electron/main/services/__tests__/voiceprint-service.test.ts`
Expected: PASS (pool round-trip; capture tests now go through the mocked `embedSamples`).

- [ ] **Step 8: Commit**

```bash
git add apps/electron/electron/main/workers/voiceprint-worker.ts apps/electron/electron/main/services/voiceprint-worker-pool.ts apps/electron/electron.vite.config.ts apps/electron/electron/main/services/voiceprint-service.ts apps/electron/electron/main/services/__tests__/voiceprint-worker-pool.test.ts apps/electron/electron/main/services/__tests__/voiceprint-service.test.ts
git commit -m "feat(electron): embed voiceprints off-thread in a utilityProcess; raise PCM cap"
```

---

## Task 5: Auto-embed every label of a recording (deferred, persisted)

**Files:**
- Modify: `electron/main/services/voiceprint-service.ts` (add `embedRecordingLabels`)
- Test: add to `voiceprint-service.test.ts`

- [ ] **Step 1: Write the failing test.** Mock DB getters + `embedSamples`; assert one persisted label embedding per label with ≥10 s clean speech, and that short labels are skipped:

```typescript
it('embedRecordingLabels embeds each ≥10s-clean label and persists, skips short labels', async () => {
  const db = await import('../database')
  vi.mocked(db.getRecordingById).mockReturnValue({ id: 'r1', file_path: '/r/r1.wav' } as never)
  vi.mocked(db.getTranscriptByRecordingId).mockReturnValue({ id: 't1', turns: JSON.stringify([
    { speaker: 'A', startMs: 0, endMs: 12000, text: 'long' },
    { speaker: 'B', startMs: 12000, endMs: 14000, text: 'short' } // 2s < 10s → skip
  ]) } as never)
  vi.mocked(db.insertLabelEmbedding).mockReset()
  const { embedRecordingLabels } = await import('../voiceprint-service')
  await embedRecordingLabels('r1')
  expect(vi.mocked(db.insertLabelEmbedding)).toHaveBeenCalledTimes(1)
  expect(vi.mocked(db.insertLabelEmbedding).mock.calls[0][0].file_label).toBe('A')
})
```

(The suite's `vi.mock('../database')` must export `insertLabelEmbedding`/`getLabelEmbeddingsForRecording` as `vi.fn()`s, and `./voiceprint-worker-pool`'s `embedSamples` must be mocked to return a `Float32Array(256)`. Add those to the existing mocks.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run electron/main/services/__tests__/voiceprint-service.test.ts -t "embedRecordingLabels"`
Expected: FAIL — `embedRecordingLabels` not exported.

- [ ] **Step 3: Implement `embedRecordingLabels`.** Decode once, slice per label (reusing `collectCleanSpeechMs` + `pcmToFloat32`), embed off-thread, persist:

```typescript
import { insertLabelEmbedding } from './database'

/** Embed EVERY label of a recording (clean-gated), off the main thread, persisting to
 *  recording_label_embeddings. Lazy/deferred caller (Phase 3 wires when the panel opens).
 *  Never throws; skips labels < MIN_CLEAN_SPEECH_MS. */
export async function embedRecordingLabels(recordingId: string): Promise<void> {
  if (!isVoiceprintAvailable()) return
  const recording = getRecordingById(recordingId)
  if (!recording?.file_path) return
  const transcript = getTranscriptByRecordingId(recordingId)
  let turns: Turn[] = []
  try { turns = transcript?.turns ? (JSON.parse(transcript.turns) as Turn[]) : [] } catch { turns = [] }
  if (turns.length === 0) return

  let pcm: Buffer
  try { pcm = await decodeRecordingPcm16k(recording.file_path) } catch (e) {
    console.warn(`[Voiceprint] embedRecordingLabels decode failed (${recordingId}): ${(e as Error).message}`); return
  }
  const labels = [...new Set(turns.map((t) => t.speaker))]
  for (const label of labels) {
    if (collectCleanSpeechMs(turns, label) < MIN_CLEAN_SPEECH_MS) continue
    const samples = pcmToFloat32(pcm, turns, label)
    if (samples.length === 0) continue
    const embedding = await embedSamples(modelPath(), 16000, samples)
    if (!embedding) continue
    insertLabelEmbedding({
      id: `le_${randomUUID()}`, recording_id: recordingId, transcript_id: transcript?.id ?? null,
      file_label: label, model_id: VOICEPRINT_MODEL_ID, model_version: 1, dim: embedding.length,
      embedding: embeddingToBlob(embedding), clean_speech_ms: collectCleanSpeechMs(turns, label),
      turn_count: turns.filter((t) => t.speaker === label).length, quality_score: null, status: 'ok'
    })
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run electron/main/services/__tests__/voiceprint-service.test.ts`
Expected: PASS — one label embedding for A, B skipped.

- [ ] **Step 5: Commit**

```bash
git add apps/electron/electron/main/services/voiceprint-service.ts apps/electron/electron/main/services/__tests__/voiceprint-service.test.ts
git commit -m "feat(electron): embedRecordingLabels — auto-embed every clean label off-thread"
```

---

## Task 6: Privacy config section (schema for Phase 2's toggle)

**Files:**
- Modify: `electron/main/services/config.ts` (add `privacy` to `AppConfig` + default)
- Test: add to an existing config test or a small new one

- [ ] **Step 1: Write the failing test.** In a config test, assert the default config has `privacy.enableVoiceprintCapture` defaulting to `true` and `excludeVoiceprintsFromBackup` `true`:

```typescript
it('config has a privacy section with voiceprint defaults', async () => {
  const { getConfig } = await import('../config')
  const cfg = getConfig()
  expect(cfg.privacy.enableVoiceprintCapture).toBe(true)
  expect(cfg.privacy.excludeVoiceprintsFromBackup).toBe(true)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run electron/main/services/__tests__ -t "privacy section"`
Expected: FAIL — `privacy` is not on `AppConfig`/default.

- [ ] **Step 3: Add the section.** In `config.ts`, add to the `AppConfig` interface (after `ui`):

```typescript
  privacy: {
    enableVoiceprintCapture: boolean       // master gate for the whole voice-library feature (spec §14)
    excludeVoiceprintsFromBackup: boolean  // keep biometric prints out of sync/backups by default
  }
```

And add the matching block to the `DEFAULT_CONFIG` object:

```typescript
  privacy: {
    enableVoiceprintCapture: true,
    excludeVoiceprintsFromBackup: true
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run electron/main/services/__tests__ -t "privacy section"`
Expected: PASS.

- [ ] **Step 5: Gate capture on the toggle.** In `voiceprint-service.ts`, at the top of both `captureVoiceprint` and `embedRecordingLabels`, return early when disabled:

```typescript
  if (!getConfig().privacy.enableVoiceprintCapture) return { captured: false, reason: 'voiceprint disabled' }
  // (embedRecordingLabels: `if (!getConfig().privacy.enableVoiceprintCapture) return`)
```

(Import `getConfig` from `./config` if not already imported.)

- [ ] **Step 6: Run the full gate + commit**

Run: `npm run typecheck && npm run lint && npm run test:run`
Expected: all green.

```bash
git add apps/electron/electron/main/services/config.ts apps/electron/electron/main/services/voiceprint-service.ts apps/electron/electron/main/services/__tests__/
git commit -m "feat(electron): privacy config section + gate voiceprint capture on the toggle"
```

---

## Final verification

- [ ] **Full gate:** `cd apps/electron && npm run typecheck && npm run lint && npm run test:run` — all green (one unrelated jsdom perf test may flake under full-suite load; re-run in isolation).
- [ ] **Packaged-build sanity (Windows):** `npm run build:win` succeeds (models:fetch pulls ERes2Net; the build can't ship without the model). Confirm `out/main/voiceprint-worker.js` is emitted and `<resources>/models/3dspeaker_eres2net_en_voxceleb.onnx` is present in the package.
- [ ] **One live smoke (user, optional):** with capture enabled, mapping a speaker writes a `voiceprints` row with `model_id='3dspeaker_eres2net_en_voxceleb'` and **no UI freeze** (compute is now in the utilityProcess).

## Self-Review

**Spec coverage (Phase 1 of rev-2):** §3 model swap → Task 1. §8 tables/provenance/CHECK-rebuild/is_self → Tasks 2-3. §6/§12 off-thread embed + PCM cap → Task 4. "auto-embed every label" (§4/§6) → Task 5. §14 privacy schema + gate → Task 6. `deleteVoiceprint` (§12) → Task 3. Deferred to Phase 2+ (noted): manual-identity UX, banking-hygiene policy/corroboration, suggestion generation/matching, conflict hierarchy, static floor, backstop, research-gated probe/auto-apply.

**Placeholder scan:** none — every code step has complete code + an exact command. The two genuine unknowns are explicit, actionable tasks, not placeholders: the ERes2Net **SHA** (Task 1 Step 6 pins it from the fetch output) and the exact upstream **asset filename** (Task 1 Step 4 says HEAD-verify + correct if 404).

**Type consistency:** `VOICEPRINT_MODEL_ID` = `'3dspeaker_eres2net_en_voxceleb'` is used identically in Tasks 1/4/5 and the builder/fetch paths. `embedSamples(modelPath, sampleRate, samples)` defined in Task 4 is called with the same signature in Tasks 4/5. `insertLabelEmbedding`'s `LabelEmbedding` shape (Task 3) matches the call site in Task 5. `recording_speakers.source` widened set is identical in the fresh SCHEMA (Task 2 Step 3) and the rebuild migration (Task 2 Step 4).
