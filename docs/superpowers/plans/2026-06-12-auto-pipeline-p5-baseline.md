# Auto-Pipeline P5 — First-Sync Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase P5 of `docs/superpowers/specs/2026-06-11-auto-pipeline-model-choice-design.md` (§5.5 → AC2, AC3): the filename-snapshot baseline — a **fresh** device's first auto-sync records its current filenames and queues **nothing**; afterwards only files outside the snapshot (and not already synced) auto-process, capped at 100/session. Manual sync is untouched. Without this, a first connect queues the entire P1 backlog through metered Whisper.

**Architecture:** `sync_baseline_files` table exists (dormant since P1's v25 migration). New: `ensureBaseline` on DownloadService + `download-service:ensure-baseline` IPC; `getFilesToSync` gains optional `{ auto, deviceSerial }`; `useDeviceSubscriptions` calls ensure-baseline then auto-mode reconciliation on BOTH its trigger paths (extracting the currently-duplicated reconcile block into one helper). Null serial → skip the auto cycle.

**Tech Stack:** sql.js, Vitest (`@vitest-environment node` main / jsdom renderer), existing renderer hook patterns.

---

## Environment / invariants

Same as P2-P4 (work from `apps/electron`; explicit RCs; house real-DB fixture for main tests; EOL parity; trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; spec §5.5 authoritative). Branch: `auto-pipeline-p5-p6` (created by the controller — SKIP branch steps).

⛔ **USB safety — this phase is the closest to USB of any phase. Hard fence:** the ONLY renderer file you may modify is `src/hooks/useDeviceSubscriptions.ts` (plus its new test). Do NOT touch `src/services/jensen.ts`, `src/services/hidock-device.ts`, `useDownloadOrchestrator.ts`, or any transfer logic. Your changes are to *what gets queued*, never to *how bytes move*. No hardware, ever.

## File structure

| File | Responsibility |
|---|---|
| `electron/main/services/download-service.ts` (modify) | `ensureBaseline()` method; `getFilesToSync` opts (`'baseline'`/`'auto-cap'` skip reasons); the two IPC handler updates |
| `electron/preload/index.ts` (modify) | `ensureBaseline` binding; `getFilesToSync` opts typing (+ honest `string \| Date` for dateCreated) |
| `src/hooks/useDeviceSubscriptions.ts` (modify) | serial read, ensure-baseline call, auto-mode opts — via one extracted reconcile helper used by both paths |
| `src/hooks/__tests__/useDeviceSubscriptions.test.ts` (create) | first renderer tests for the auto-sync trigger (none exist today) |
| Tests (main) | extend `electron/main/services/__tests__/download-service.test.ts` (its fixture idiom) or a new `baseline-sync.test.ts` if that file's mock style doesn't fit real-DB needs — implementer's call, state it |

---

### Task 1: `ensureBaseline` + baseline-aware `getFilesToSync` (main process)

**Files:** `electron/main/services/download-service.ts`; test per File-structure note

- [ ] **Step 1: Read the live code.** `getFilesToSync` (download-service.ts:297-315, verbatim signature `getFilesToSync(deviceFiles: Array<{ filename: string; size: number; duration: number; dateCreated: Date }>)`), `isFileAlreadySynced` (:245-292), the IPC registrations (`'download-service:get-files-to-sync'` :1030-1031, `'download-service:is-file-synced'` :1025). The `sync_baseline_files` schema: `(device_serial TEXT, filename TEXT, created_at TEXT, PRIMARY KEY(device_serial, filename))`.
- [ ] **Step 2: Failing tests** (real-DB fixture; seed `synced_files`/`recordings` rows via the database helpers used by existing download-service/database-v25 tests):
  1. **Fresh device:** no baseline rows + no filename overlap with synced history → `ensureBaseline('SN1', ['a.hda','b.hda'])` returns `{ created: true }` and inserts 2 rows keyed `('SN1','a.hda')`/`('SN1','b.hda')`.
  2. **Already baselined:** second call for `'SN1'` (any filenames) → `{ created: false }`, row count unchanged.
  3. **Prior-sync grandfather (spec §5.5 / AC7):** no baseline rows for `'SN2'`, but one of its filenames IS already synced (seed via `addSyncedFile` or direct insert) → `{ created: false }` and NO rows inserted — a device with history keeps today's behavior.
  4. **Auto mode skips baseline files:** baseline `('SN1','a.hda')`; `getFilesToSync([a,c], { auto: true, deviceSerial: 'SN1' })` → `a.hda` has `skipReason: 'baseline'`, `c.hda` has none. Existing 4-layer reasons still win first (an already-synced file keeps its synced reason, not 'baseline').
  5. **Manual semantics untouched:** `getFilesToSync([a,c])` (no opts) and `getFilesToSync([a,c], { auto: false })` → NO 'baseline' skips (AC3).
  6. **Auto without serial = manual semantics:** `{ auto: true }` with no deviceSerial → no baseline filtering (defensive; the renderer never sends this).
  7. **100-file cap:** 120 unsynced non-baseline files in auto mode → exactly 100 with no skipReason, 20 with `skipReason: 'auto-cap'`; manual mode → all 120 queued.
- [ ] **Step 3: Implement.**
  (a) `ensureBaseline` method on DownloadService (near `isFileAlreadySynced`):
```ts
  /**
   * First-sync baseline (spec §5.5): snapshot a FRESH device's current filenames
   * so its backlog is never auto-processed. Fresh = no baseline rows for this
   * serial AND no prior sync history for any of its files — a device the user
   * has synced before gets NO baseline (auto-sync keeps today's behavior; AC7).
   * Explicit call — getFilesToSync stays a pure read.
   */
  ensureBaseline(deviceSerial: string, filenames: string[]): { created: boolean } {
    const existing = queryOne<{ n: number }>(
      'SELECT 1 AS n FROM sync_baseline_files WHERE device_serial = ? LIMIT 1',
      [deviceSerial]
    )
    if (existing) return { created: false }
    const hasPriorHistory = filenames.some((f) => this.isFileAlreadySynced(f).synced)
    if (hasPriorHistory) return { created: false }
    for (const filename of filenames) {
      run(
        'INSERT OR IGNORE INTO sync_baseline_files (device_serial, filename, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [deviceSerial, filename]
      )
    }
    console.log(`[DownloadService] Baseline established for ${deviceSerial}: ${filenames.length} files`)
    return { created: true }
  }
```
  (b) `getFilesToSync` gains opts (defaulting to manual — the display caller `Device.tsx:467` and all existing call sites are untouched):
```ts
  getFilesToSync(
    deviceFiles: Array<{ filename: string; size: number; duration: number; dateCreated: Date }>,
    opts?: { auto?: boolean; deviceSerial?: string }
  ): Array<{ filename: string; size: number; duration: number; dateCreated: Date; skipReason?: string }> {
    const AUTO_QUEUE_CAP = 100 // spec §5.5 defense-in-depth: no single bug can queue an unbounded metered-ASR bill
    const autoMode = opts?.auto === true && !!opts?.deviceSerial
    const baseline = autoMode
      ? new Set(
          queryAll<{ filename: string }>(
            'SELECT filename FROM sync_baseline_files WHERE device_serial = ?',
            [opts!.deviceSerial!]
          ).map((r) => r.filename)
        )
      : null
```
  Loop order per file: (1) existing `isFileAlreadySynced` reasons win first; (2) else `baseline?.has(filename)` → `skipReason: 'baseline'`; (3) else if `autoMode && queuedCount >= AUTO_QUEUE_CAP` → `skipReason: 'auto-cap'`; (4) else `queuedCount++`. Keep the existing summary `console.log`, extended with baseline/cap counts.
  (c) IPC: extend the existing handler (verbatim anchor :1030-1031) with the opts param, and add the new channel next to it:
```ts
  ipcMain.handle(
    'download-service:get-files-to-sync',
    (_, files: Array<{ filename: string; size: number; duration: number; dateCreated: Date }>,
        opts?: { auto?: boolean; deviceSerial?: string }) => {
      return service.getFilesToSync(files, opts)
    }
  )

  // First-sync baseline (spec §5.5) — explicit, called by the renderer auto-sync paths only.
  ipcMain.handle('download-service:ensure-baseline', (_, deviceSerial: string, filenames: string[]) => {
    return service.ensureBaseline(deviceSerial, filenames)
  })
```
- [ ] **Step 4: Tests PASS + neighbors** (`download-service.test.ts` + `-b007` + `-c004` + `database-v25`), RCs 0. Commit: `feat(electron): first-sync baseline — ensureBaseline + auto-mode getFilesToSync with baseline/auto-cap skips (auto-pipeline P5)`

---

### Task 2: Preload bindings

**Files:** `electron/preload/index.ts`

- [ ] **Step 1:** Type block (`downloadService` at :332; `getFilesToSync` type at :353 — verbatim in the facts): change the `getFilesToSync` type to accept the optional opts and be honest about IPC serialization (`dateCreated: string | Date` both directions — see the `Device.tsx:490` comment precedent); add below it:
```ts
    ensureBaseline: (deviceSerial: string, filenames: string[]) => Promise<{ created: boolean }>
```
  Impl block (`downloadService` at :719; `getFilesToSync` impl at :722): `getFilesToSync: (files, opts) => callIPC('download-service:get-files-to-sync', files, opts),` and `ensureBaseline: (deviceSerial, filenames) => callIPC('download-service:ensure-baseline', deviceSerial, filenames),`
- [ ] **Step 2:** `npm run typecheck; echo RC=$?` (both tsconfigs — the renderer consumes these types). Existing renderer callers compile unchanged (opts optional). Commit: `feat(electron): preload — ensureBaseline binding + getFilesToSync opts (auto-pipeline P5)`

---

### Task 3: Renderer wiring — one reconcile helper, both auto paths (THE delicate task)

**Files:** `src/hooks/useDeviceSubscriptions.ts`; create `src/hooks/__tests__/useDeviceSubscriptions.test.ts`

> The two auto paths duplicate the reconcile block verbatim today (status-ready path :114-143; pre-connected path :235-265). Extract ONE module-level helper and call it from both — this is the only sanctioned refactor; everything else in the file stays byte-identical. ⛔ Do not touch listRecordings/startSession internals, jensen, hidock-device, or the orchestrator.

- [ ] **Step 1: Failing renderer tests.** Create `src/hooks/__tests__/useDeviceSubscriptions.test.ts` (jsdom; follow the mocking idioms of the nearest hook test, e.g. `useDownloadOrchestrator.test.ts` — read it first). Mock `@/services/hidock-device` (`getHiDockDeviceService` returning a controllable fake with `getState` incl. `serialNumber`, `getCachedRecordings`, `getConnectionStatus`, `onStateChange`/`onStatusChange`/`onActivity` capture, `log`, `isConnected`), `@/utils/autoSyncGuard` (`checkAutoSyncAllowed` → allowed, `waitForConfig`/`waitForDeviceReady` → true), and `window.electronAPI.downloadService` (`ensureBaseline`, `getFilesToSync`, `startSession`, `cancelActive`). Use fake timers for the 2 s debounce. Drive the status-ready path by invoking the captured `onStatusChange` callback with `{ step: 'ready' }`. Tests:
  1. **Fresh device:** `ensureBaseline` resolves `{ created: true }` → it was called with the device serial + cached filenames; `getFilesToSync` and `startSession` NOT called; a baseline log entry emitted (AC2 first half).
  2. **Baselined device:** `ensureBaseline` → `{ created: false }`; `getFilesToSync` called with `(files, { auto: true, deviceSerial: 'SN1' })`; `startSession` called with the non-skipped files (AC2 second half).
  3. **Null serial:** `getState().serialNumber = null` → neither `ensureBaseline` nor `getFilesToSync` called; a QA/log skip line; no throw (the path's catch at :144-145 must not be the thing saving us — assert the functions were simply not invoked).
  4. **All-skipped:** `getFilesToSync` returns everything with skipReasons → `startSession` NOT called, 'All files synced' log (existing behavior preserved).
- [ ] **Step 2: Implement.** Extract the duplicated block into a module-level helper in the same file:
```ts
/** Shared auto-sync reconcile (spec §5.5): baseline-gate then auto-mode
 *  reconciliation. Used by both trigger paths. Returns without queueing when
 *  the device has no serial (never key a baseline on null) or when this
 *  connect just established the baseline. */
async function runAutoSyncReconcile(
  deviceService: ReturnType<typeof getHiDockDeviceService>,
  recordings: Array<{ filename: string; size: number; duration: number; dateCreated?: Date }>,
  setDeviceSyncState: (s: { deviceSyncing: boolean; deviceSyncProgress: { total: number; current: number }; deviceFileDownloading: string | null }) => void
): Promise<void> {
  const deviceSerial = deviceService.getState().serialNumber
  if (!deviceSerial) {
    if (shouldLogQa()) console.log('[useDeviceSubscriptions] Auto-sync skipped: device reported no serial number')
    deviceService.log('info', 'Auto-sync skipped', 'Device reported no serial number')
    return
  }
  const { created } = await window.electronAPI.downloadService.ensureBaseline(
    deviceSerial,
    recordings.map((r) => r.filename)
  )
  if (created) {
    deviceService.log(
      'info',
      'Baseline established',
      `${recordings.length} existing recordings recorded as baseline — new recordings will sync automatically from now on`
    )
    return
  }
  const reconcileResults = await window.electronAPI.downloadService.getFilesToSync(
    recordings.map((rec) => ({
      filename: rec.filename,
      size: rec.size,
      duration: rec.duration,
      dateCreated: rec.dateCreated
    })),
    { auto: true, deviceSerial }
  )
  // [remainder = the existing toSync/filesToQueue/startSession/log block, moved verbatim
  //  from :124-142 — including the setDeviceSyncState call and the 'All files synced' log]
}
```
  Replace the bodies at :114-143 (inside the debounce, after the `recordings.length > 0` check) and :235-265 with `await runAutoSyncReconcile(deviceService, recordings, setDeviceSyncStateRef.current)`. Everything around them (debounce, locks, listRecordings fetch, error handling, flag resets) stays byte-identical.
- [ ] **Step 3: Tests PASS** (`npx vitest run src/hooks/__tests__/useDeviceSubscriptions.test.ts; echo RC=$?`) + the neighboring hook suites (`useDownloadOrchestrator`, `useUnifiedRecordings`) still green + full typecheck RC 0.
- [ ] **Step 4: Commit.** `feat(electron): auto-sync baseline gate — ensure-baseline + auto-mode reconciliation on both trigger paths (auto-pipeline P5)`

---

### Task 4: Full gates + AC2/AC3 evidence

- [ ] typecheck / lint / `npm run test:run` — explicit RCs, all 0 (known WASM flake: re-run once).
- [ ] **AC2 evidence:** Task 1 tests 1/2/4 + Task 3 tests 1/2 (snapshot-then-nothing; additions-only afterwards; failed-download retry falls out of set-difference — name Task 1 test 4's "synced reasons win first" assertion).
- [ ] **AC3 evidence:** Task 1 test 5 (manual reaches pre-baseline files).
- [ ] Report with any deviations cited.

## Done criteria (spec §12 P5 → AC2/AC3)
- [ ] Fresh device: first auto-sync snapshots and queues nothing; prior-sync devices grandfathered (no baseline).
- [ ] Subsequent auto-syncs: baseline + synced files skipped, ≤100 queued, manual untouched.
- [ ] Null-serial auto cycle skipped safely. Both trigger paths share one reconcile helper.
- [ ] Gates green; zero changes to USB/transfer code.

## Explicitly NOT in P5
- Any change to jensen/hidock-device/useDownloadOrchestrator/transfer logic.
- Baseline management UI (viewing/clearing baselines — future).
- P6's integration e2e + physical test.
