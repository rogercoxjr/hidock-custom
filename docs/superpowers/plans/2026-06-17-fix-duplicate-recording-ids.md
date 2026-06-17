# Fix Duplicate Recording IDs (date-match not 1:1 on db id) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. TDD throughout: write the failing test first, RUN it and confirm RED for the right reason, implement minimally, RUN and confirm GREEN, then commit.

**Goal:** The unified recording list produced by `buildRecordingMap` never emits two entries with the same `id`. This eliminates the `[Library] Duplicate recording IDs detected` warning and the React `Encountered two children with the same key` error in the Library list.

**Architecture:** A single, surgical change inside the date-match fallback path of `buildRecordingMap` in `apps/electron/src/hooks/useUnifiedRecordings.ts`. We add a `claimedDbIds: Set<string>` that records every db/synced `id` already consumed as a recording key, and we reject a date-match that would reuse an already-claimed id (falling back to treating that device recording as device-only, keyed by `deviceRec.id`). No USB/device code is touched. No IPC, no DB, no UI changes. Pure in-memory mapping logic.

**Tech Stack:** React 18 renderer (TypeScript), Vitest + Testing Library. Run gates from `apps/electron`: `npm run typecheck` and `npx vitest run src/hooks/__tests__/useUnifiedRecordings.test.ts`.

---

## Root Cause (with file:line evidence)

All line references are `apps/electron/src/hooks/useUnifiedRecordings.ts`.

**The id assigned to a `both`-location recording is the matched db/synced row id:**
```
:193  if (synced || dbRec) {
:194    const dbId = dbRec?.id || synced!.id
:197    const recording: BothLocationsRecording = {
:198      id: dbId,
        ...
:216    recordingMap.set(baseName, recording)   // keyed by DEVICE rec base name, id = dbId
```

**The date-match fallback (used when no exact filename/base match exists):**
```
:181  if (!synced && !dbRec) {
:182    const dateMatch = findMatchByDateTime(deviceRec, dbRecs, syncedFiles, processedBaseNames)
:183    if (dateMatch) {
:184      dbRec = dateMatch.dbRec
:185      synced = dateMatch.synced
:186      localBaseName = dateMatch.localBaseName
```

**The only dedup guard `findMatchByDateTime` applies is by *base filename*, not by *id*** (`:108-110`):
```
:108  for (const dbRec of dbRecs) {
:109    const baseName = getBaseFilename(dbRec.filename)
:110    if (matchedBaseNames.has(baseName)) continue // Already matched
```
…and after a date-match the device loop adds the matched row's base name to the live set (`:218-221`):
```
:218  // IMPORTANT: If matched by date, also track the local file's baseName ...
:219  if (localBaseName && localBaseName !== baseName) {
:220    processedBaseNames.add(localBaseName)
:221  }
```

**Why base-name dedup is NOT 1:1 on the id.** The React key (and the value compared in `Library.tsx:400-406`) is `id`, but the date-match fallback only guarantees that no single db **row base name** is reused — it never guarantees that no db **id** is reused. The two are not equivalent: distinct db rows can carry the same `id` (e.g. a `recordings` row and a re-import / duplicate-import row, or a `synced_files` id that collides with a `recordings` id, since `dbId = dbRec?.id || synced!.id` draws from either source at `:194`). When two device recordings made seconds apart each date-match a *different* db row that happens to share the same `id`, the base-name guard does not fire (different base names), and both produce `id = <sameId>` → duplicate keys.

**Reproduced (isolated trace of the exact `:172-237` logic).** Two device recs 30s apart, two db rows with distinct base names but the same id, both within the 60s tolerance:
- device `2025-12-08_004400.hda` → date-matches db row `alpha-no-date-1` (id `DUP`) → entry `{ key: '2025-12-08_004400', id: 'DUP' }`
- device `2025-12-08_004430.hda` → date-matches db row `beta-no-date-2` (id `DUP`) → entry `{ key: '2025-12-08_004430', id: 'DUP' }`

Result: two map entries (distinct base-name keys, so neither overwrites the other in `recordingMap`) with `id === 'DUP'`. The base-name guard never fired because the two matched rows have different base names. `Library.tsx:399-407` then reports the duplicate and React throws on the duplicate key.

> Note: the existing `localBaseName` guard (`:218-221`) already prevents the *same db row* from being re-matched by two device recs, so the surviving defect is specifically the **two-distinct-rows-sharing-an-id** path. The fix below deduplicates on the actual React key (`id`), which closes both the row-reuse path and the shared-id path.

---

## Fix Design (TDD)

Deduplicate on the value that actually becomes the React key — the `id` — by tracking claimed db/synced ids in a `Set` and rejecting any date-match that would reuse one.

### Why fall back to device-only (not skip / not synthesize a new id)
- The device recording genuinely exists on the device; dropping it would hide a real file.
- `deviceRec.id` is the device file's stable identifier and is already the id used on the non-matched (`else`) branch at `:222-236`, so `id = deviceRec.id` is the established, collision-free identity for an unmatched device recording. Device ids and db ids do not collide in practice (device ids are device-file handles; db ids are DB row ids), and the new `claimedDbIds` set also lets us assert this in the test.
- Falling back to device-only is the truthful state: we could not confidently/uniquely associate this device file with a distinct local row.

### File Structure
- `apps/electron/src/hooks/useUnifiedRecordings.ts`
  - **Export** `buildRecordingMap` (currently module-private at `:133`) so it can be unit-tested directly. Change `function buildRecordingMap(` → `export function buildRecordingMap(`. (Also export the `DatabaseRecording`, `SyncedFile`, `CachedDeviceFile` interfaces if the test needs to type fixtures — optional; tests can use `as any` per the existing idiom in this file's sibling test, which already uses `// @ts-expect-error` narrowing.)
  - Introduce `const claimedDbIds = new Set<string>()` alongside `processedBaseNames`/`recordingMap` (~`:168-169`).
  - In the `if (synced || dbRec)` branch, after computing `dbId` (`:194`): if the row was produced by the **date-match fallback** (i.e. `localBaseName` is set) AND `claimedDbIds.has(dbId)`, treat this device recording as device-only instead (build the `DeviceOnlyRecording` with `id: deviceRec.id`, key by `baseName`, `processedBaseNames.add(baseName)`, and do NOT touch `claimedDbIds`). Otherwise build the `both` recording as today and `claimedDbIds.add(dbId)`.
  - For the exact-match branch and the `LocalOnlyRecording` loop (`:240-274`), also `claimedDbIds.add(...)` the id used, so an exact match claims its id ahead of any later date-match (exact matches are authoritative; ordering: device loop runs before the db-only loop, matching today's behavior).
  - Guard scope: only the **date-match** path falls back to device-only. Exact filename/base matches are authoritative and must keep `id = dbId` (changing them could regress the established `both` identity). The cleanest implementation gates the fallback on `localBaseName != null` (only the date-match path sets it, per `:186`).

### Failing Test Design

**File:** `apps/electron/src/hooks/__tests__/useUnifiedRecordings.test.ts` (add a new `describe('buildRecordingMap — duplicate id prevention', ...)` block; import the now-exported `buildRecordingMap`).

Because `buildRecordingMap` is pure, the test calls it directly — no `renderHook`, no `window.electronAPI`, no timers. This avoids the async/debounce machinery in the hook and tests the unit in isolation.

**Test 1 — two device recs date-match two db rows sharing one id ⇒ ids are unique (the bug repro):**
```ts
import { buildRecordingMap } from '../useUnifiedRecordings'

it('produces unique ids when two device recs date-match db rows that share an id', () => {
  const deviceRecs = [
    { id: 'dev-a', filename: '2025-12-08_004400.hda', size: 1, duration: 1,
      dateCreated: new Date('2025-12-08T00:44:00'), version: 1, signature: '' },
    { id: 'dev-b', filename: '2025-12-08_004430.hda', size: 1, duration: 1,
      dateCreated: new Date('2025-12-08T00:44:30'), version: 1, signature: '' },
  ] as any
  // Two DISTINCT db rows (different base names ⇒ base-name guard does NOT fire)
  // that share the SAME id, both within the 60s date-match tolerance of both device recs.
  const dbRecs = [
    { id: 'DUP', filename: 'alpha-no-date-1', file_path: '/a', file_size: 1,
      status: 'complete', date_recorded: '2025-12-08T00:44:05' },
    { id: 'DUP', filename: 'beta-no-date-2',  file_path: '/b', file_size: 1,
      status: 'complete', date_recorded: '2025-12-08T00:44:25' },
  ] as any

  const result = buildRecordingMap(deviceRecs, dbRecs, [], [], true, [])

  const ids = result.map(r => r.id)
  expect(new Set(ids).size).toBe(ids.length) // RED today: 'DUP' appears twice
})
```
**Confirm RED for the right reason:** before the fix, `ids` is `['DUP', 'DUP']` (or `['DUP', ...]` with a collision) so `new Set(ids).size (1..) < ids.length (2)`. The failure message must show the duplicate `'DUP'`, not a fixture/parse error — if the test errors instead of asserting, the date fixtures aren't parsing within tolerance; verify with a sanity sub-assert (below) first.

**Test 2 — the second device rec falls back to device-only (keyed by deviceRec.id):**
```ts
it('falls back to device-only for the rec whose date-match would reuse a claimed id', () => {
  // …same fixtures…
  const result = buildRecordingMap(deviceRecs, dbRecs, [], [], true, [])
  // exactly one entry keeps the claimed db id; the other becomes device-only with the device id
  const both = result.filter(r => r.location === 'both')
  const deviceOnly = result.filter(r => r.location === 'device-only')
  expect(both).toHaveLength(1)
  expect(both[0].id).toBe('DUP')
  expect(deviceOnly).toHaveLength(1)
  expect(['dev-a', 'dev-b']).toContain(deviceOnly[0].id) // device-file id, not 'DUP'
})
```

**Test 3 (regression guard) — the normal single date-match still yields a `both` recording:**
```ts
it('still date-matches a single device rec to a unique db row (no regression)', () => {
  const deviceRecs = [
    { id: 'dev-a', filename: '2025-12-08_004400.hda', size: 1, duration: 1,
      dateCreated: new Date('2025-12-08T00:44:00'), version: 1, signature: '' },
  ] as any
  const dbRecs = [
    { id: 'DBID-X', filename: 'meeting-notes-download', file_path: '/x', file_size: 1,
      status: 'complete', date_recorded: '2025-12-08T00:44:10' },
  ] as any
  const result = buildRecordingMap(deviceRecs, dbRecs, [], [], true, [])
  expect(result).toHaveLength(1)
  expect(result[0].location).toBe('both')
  expect(result[0].id).toBe('DBID-X')
})
```
This proves the fix only suppresses the *duplicate* id, never the first/legitimate match.

---

## Task 1: Export `buildRecordingMap` + add the unique-id tests (RED)

**Files:**
- Modify: `apps/electron/src/hooks/useUnifiedRecordings.ts:133` (export the function only)
- Modify: `apps/electron/src/hooks/__tests__/useUnifiedRecordings.test.ts` (add the new describe block + import)

- [ ] **Step 1: Export** `buildRecordingMap` — change `function buildRecordingMap(` to `export function buildRecordingMap(` (no behavior change yet). Run `npm run typecheck` to confirm the export compiles.
- [ ] **Step 2: Add Tests 1–3** above (new `describe` block; `import { buildRecordingMap } from '../useUnifiedRecordings'`).
- [ ] **Step 3: Run, confirm RED for the right reason** — `cd apps/electron && npx vitest run src/hooks/__tests__/useUnifiedRecordings.test.ts`. Test 1 and Test 2 must FAIL with a duplicate-id assertion (ids `['DUP','DUP']`), NOT a fixture/parse error. Test 3 should already PASS. If Test 1 errors instead of failing on the assertion, fix the date fixtures (ensure `parseDateFromFilename` parses `2025-12-08_004400` and the `date_recorded` strings land within the 60s window).
- [ ] **Step 4: Commit (tests + export only)** — stage exactly the two files:
  `git add apps/electron/src/hooks/useUnifiedRecordings.ts apps/electron/src/hooks/__tests__/useUnifiedRecordings.test.ts`
  Commit message: `test(electron): RED — buildRecordingMap emits duplicate ids when two device recs date-match db rows sharing an id`
  Trailer (append exactly): `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

## Task 2: Implement the `claimedDbIds` fix (GREEN)

**Files:**
- Modify: `apps/electron/src/hooks/useUnifiedRecordings.ts` (`buildRecordingMap` body, ~`:168-274`)

- [ ] **Step 1:** Add `const claimedDbIds = new Set<string>()` next to `processedBaseNames`/`recordingMap` (~`:168-169`).
- [ ] **Step 2:** In the `if (synced || dbRec)` branch (`:193`), after `const dbId = dbRec?.id || synced!.id` (`:194`), insert the fallback guard. Sketch (match surrounding style/indentation and the file's existing EOL — no whole-file reflow):

```ts
const dbId = dbRec?.id || synced!.id

// FL: the date-match fallback is not 1:1 on the db id — two device recs made seconds
// apart can date-match distinct db rows that share an id, producing duplicate React keys.
// If this match came from the date-match path (localBaseName set) and the id is already
// claimed, treat this device recording as device-only instead of reusing the id.
if (localBaseName && claimedDbIds.has(dbId)) {
  const recording: DeviceOnlyRecording = {
    id: deviceRec.id,
    filename: deviceRec.filename,
    size: deviceRec.size,
    duration: deviceRec.duration,
    dateRecorded,
    transcriptionStatus: 'none',
    location: 'device-only',
    deviceFilename: deviceRec.filename,
    syncStatus: 'not-synced'
  }
  recordingMap.set(baseName, recording)
  processedBaseNames.add(baseName)
  continue
}
```
(Note: `dateRecorded` is computed at `:191` before this branch, so it is in scope. Use `continue` to skip the `both` construction; this is inside the `for (const deviceRec of deviceRecs)` loop so `continue` is valid.)

- [ ] **Step 3:** On the normal `both` construction path, after `recordingMap.set(baseName, recording)` / `processedBaseNames.add(baseName)` (`:216-221`), add `claimedDbIds.add(dbId)`.
- [ ] **Step 4:** In the `LocalOnlyRecording` loop, after building each local-only recording (`:271-272`), add `claimedDbIds.add(dbRec.id)` (keeps the set consistent; harmless even though this loop runs after the device loop and only processes unmatched base names).
- [ ] **Step 5: Run, confirm GREEN** — `npx vitest run src/hooks/__tests__/useUnifiedRecordings.test.ts`. All three new tests pass; all pre-existing tests in the file stay green.
- [ ] **Step 6: Typecheck** — `npm run typecheck` → 0 errors.
- [ ] **Step 7: Commit (implementation only)** — stage exactly:
  `git add apps/electron/src/hooks/useUnifiedRecordings.ts`
  Commit message: `fix(electron): dedupe recording ids by claimed db id; date-match reuse falls back to device-only`
  Trailer (append exactly): `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

## Final Verification

- [ ] `cd apps/electron && npx vitest run src/hooks/__tests__/useUnifiedRecordings.test.ts` → all green (note new test count).
- [ ] `npm run typecheck` → 0 errors.
- [ ] Confirm no USB/device files were touched (`git diff --name-only` shows only `useUnifiedRecordings.ts` and its test file).
- [ ] Confirm staged files were only the two intended files at each commit (the working tree has unrelated untracked files — never stage them).

## Self-Review notes
- **Scope discipline:** only the date-match fallback path (`localBaseName` set) changes behavior. Exact filename/base matches and the local-only loop keep their existing ids; they only *populate* `claimedDbIds` so the date-match path can detect collisions.
- **Why dedup on id, not base name:** `Library.tsx:399-407` and React both key on `id`. The pre-existing `localBaseName` guard (`:218-221`) deduped on base name, which is a proxy that fails when two distinct db rows share an id. Deduping on `dbId` directly is the precise invariant the consumer requires.
- **No data loss:** a device recording that loses its date-match still appears (as device-only with its own device id), so the user never sees a file vanish.
- **USB safety:** no change to `hidock-device.ts`, `jensen.ts`, or any `transferIn`/`startPoll` code. `buildRecordingMap` is pure in-memory mapping.
- **Ordering invariant relied upon:** the device loop (`:172-237`) runs before the local-only loop (`:240-274`), so device-side exact matches claim their ids first — unchanged from current behavior.
