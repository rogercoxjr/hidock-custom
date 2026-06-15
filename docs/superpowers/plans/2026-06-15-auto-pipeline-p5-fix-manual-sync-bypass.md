# Auto-Pipeline P5 Fix — Manual-Sync Baseline Bypass + Guard Race

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three defects found by the first real P1 plug-in (AC1), where clicking the **Sync** button on a fresh device queued the entire 58-file backlog (~3 GB) for download + downstream metered transcription, bypassing the P5 first-sync baseline. **Chosen policy (user decision):** manual Sync still downloads everything (AC3 preserved) but **prompts once for confirmation when the batch is large**, before flooding the queue.

**Architecture:** Renderer + docs only — **no main-process/transfer-code changes**. Defect 1: a `ConfirmDialog` gate in `Device.tsx` `handleSyncAll`. Defect 2: amend spec §5.5/AC3 (the spec mislabeled the queue caller as "display, untouched"). Defect 3: close the `useDeviceSubscriptions` auto-sync guard race by locking at debounce-*schedule* time, with a concurrent-paths regression test.

**Tech Stack:** React 18 + Radix `AlertDialog` (via `@/components/ConfirmDialog`), Zustand, Vitest (jsdom for renderer).

---

## Diagnosis recap (authoritative — from the debugger root-cause)

- **Auto-sync worked correctly:** on connect it called `ensureBaseline` (recorded the 58-file backlog) and queued nothing — no "Started sync session" line in the log. The baseline is fine.
- **The Sync button did it:** `Device.tsx` `handleSyncAll` (:441) → `getFilesToSync(filesToCheck)` **with no opts → manual mode → baseline filter skipped** (`0 baseline` in the log) → `queueDownloads` queued all 58. Manual sync has no 100-cap either.
- **AC3 says manual *should* reach pre-baseline files** — so this is a *design gap*, not a pipeline failure: §5.5 line 141 mislabeled `Device.tsx:467` as a "display caller … untouched" when it is the manual-queue entry point, and AC2 (first connect queues nothing) was never reconciled with AC3 for fresh devices.
- **Latent:** the auto-sync guard race (`useDeviceSubscriptions.ts`) — Path A sets `autoSyncTriggeredRef` *inside* its 2 s debounce (:152) while Path B sets it synchronously (:253), so both can run in the window. Harmless on a fresh device (ensureBaseline's `created:true` short-circuits the second), but on a device *with* new files both could call `startSession` (double-queue). Not the cause of this incident, fixed here opportunistically.

## Environment / invariants

- Work from `apps/electron`: `cd /c/Users/rcox/hidock-tools/hidock-next/apps/electron` (Git Bash).
- Run one test file: `npx vitest run <path>; echo RC=$?` — **always check RCs explicitly; `| tail` masks failures.**
- ⛔ **USB safety:** Defect 3 edits `useDeviceSubscriptions.ts` (guard timing ONLY) — do NOT touch `jensen.ts`, `hidock-device.ts`, `useDownloadOrchestrator.ts`, or any transfer logic. No hardware. The user re-runs the physical AC1 test after this lands.
- EOL: after staging, `git diff --cached --stat` must equal `git diff --cached --ignore-cr-at-eol --stat`; fix new files with `sed -i 's/\r$//'`.
- Commits end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch: `auto-pipeline-p5-fix` off `main` (created by the controller — SKIP branch steps).
- Existing tests that must stay green: `download-service.test.ts` (+b007/+c004), `baseline-sync.test.ts`, `useDeviceSubscriptions.test.ts`, the Device page test if one exists.

## File structure

| File | Responsibility |
|---|---|
| `docs/superpowers/specs/2026-06-11-auto-pipeline-model-choice-design.md` (modify) | §5.5 mislabel fix + AC3 confirm-policy reconciliation (Defect 2) |
| `src/pages/Device.tsx` (modify) | `handleSyncAll` → confirm gate on large batches; extract `performSync` (Defect 1) |
| `src/pages/__tests__/Device.test.tsx` (create or extend) | confirm-gate tests |
| `src/hooks/useDeviceSubscriptions.ts` (modify) | lock `autoSyncTriggeredRef` at debounce-schedule (Defect 3) |
| `src/hooks/__tests__/useDeviceSubscriptions.test.ts` (extend) | concurrent-paths single-run regression test |

---

### Task 1: Spec amendment — reconcile AC2/AC3, fix the §5.5 mislabel (Defect 2)

**Files:** Modify `docs/superpowers/specs/2026-06-11-auto-pipeline-model-choice-design.md`

Do this FIRST so the spec is authoritative for Task 2's behavior. No tests (docs).

- [ ] **Step 1:** In §5.5, find the sentence calling `Device.tsx:467` a display caller (the plan's facts cite line ~141, wording: "the existing display caller (`Device.tsx:467`) ... untouched"). Replace with the truth + the policy:
  > `getFilesToSync`'s `opts` default to `{ auto: false }`, so the **manual** caller — `Device.tsx` `handleSyncAll` (the Sync button) — keeps full reach over the backlog per AC3. To prevent a fresh-device Sync click from silently flooding the queue (and downstream metered transcription) with the entire backlog, `handleSyncAll` shows a one-time confirmation when the batch is large (count/size threshold) before queueing. The baseline gate remains AUTO-sync-only; manual sync is intentionally baseline-bypassing but guarded by the confirmation.
- [ ] **Step 2:** Update AC3 to: "manual sync reaches pre-baseline files (no baseline filtering when `auto:false`); a large manual sync (> threshold) prompts for confirmation before queueing." Add **AC10:** "On a fresh device, clicking Sync with a large backlog shows a confirmation dialog stating the file count and estimated size; cancelling queues nothing; confirming queues all selected files (AC3 reach preserved)."
- [ ] **Step 3:** Add a one-line note to §10 (out of scope / known) or a new "Post-AC1 fixes" note: the auto-sync guard race (Defect 3) is closed by locking at debounce-schedule time.
- [ ] **Step 4:** Commit. `docs(spec): reconcile AC2/AC3 — manual Sync is baseline-bypassing but confirms on large batches; fix the Device.tsx:467 mislabel (auto-pipeline P5 fix)`

---

### Task 2: Confirmation gate on large manual Sync (Defect 1 — the primary fix)

**Files:** Modify `src/pages/Device.tsx`; create/extend `src/pages/__tests__/Device.test.tsx`

The current `handleSyncAll` (Device.tsx:441) computes `toSync` then immediately calls `queueDownloads` (~:491). Split it: compute → if large, open a confirm dialog → queue only on confirm. Reuse `@/components/ConfirmDialog` (props: `open`, `onOpenChange`, `title`, `description`, `actionLabel`, `cancelLabel`, `variant`, `onConfirm`) and the state pattern from `Library.tsx:240/1172`.

- [ ] **Step 1: Failing tests.** Create (or extend) `src/pages/__tests__/Device.test.tsx` (jsdom; mock `window.electronAPI.downloadService` `getFilesToSync`/`queueDownloads`, `@/services/hidock-device`, the config + app stores per the Settings/Library test idioms). Tests:
  1. **Small sync proceeds silently:** `getFilesToSync` returns 3 non-skipped files → clicking Sync calls `queueDownloads` with 3 files and shows NO confirm dialog.
  2. **Large sync confirms first:** `getFilesToSync` returns 58 non-skipped files → clicking Sync does NOT call `queueDownloads` yet; a dialog renders with text containing "58" and an estimated size; `queueDownloads` is called only after the dialog's confirm action.
  3. **Cancel queues nothing:** large batch → open dialog → cancel → `queueDownloads` never called, `deviceSyncing` returns to false.
  4. **Threshold by size:** 4 files but totalling > 200 MB → confirm dialog shown (size trips the threshold even though count is under it).
  5. **All-synced unchanged:** `getFilesToSync` returns all-skipped → "All synced" toast, no dialog, no queue.
- [ ] **Step 2: Run — FAIL** (no dialog/threshold logic yet).
- [ ] **Step 3: Implement.**
  - Add a module-level constant near the top of the file: `const SYNC_CONFIRM_FILE_THRESHOLD = 5` and `const SYNC_CONFIRM_BYTES_THRESHOLD = 200 * 1024 * 1024 // 200 MB`.
  - Add state (with the other `useState`s): `const [syncConfirm, setSyncConfirm] = useState<{ open: boolean; files: Array<{ filename: string; size: number; dateCreated?: string }>; totalBytes: number }>({ open: false, files: [], totalBytes: 0 })`.
  - Refactor `handleSyncAll`: keep the connection check, the `filesToCheck`/`getFilesToSync`/`toSync` computation, and the `toSync.length === 0 → "All synced"` early return EXACTLY as today, but do NOT set `deviceSyncing:true` up front anymore (move it into `performSync`). After computing `toSync`, build the queue payload (the existing `toSync.map(...)` with the `dateCreated` ISO handling) into `filesToQueue`, compute `totalBytes = toSync.reduce((s, f) => s + (f.size || 0), 0)`, then:
    ```ts
    if (toSync.length > SYNC_CONFIRM_FILE_THRESHOLD || totalBytes > SYNC_CONFIRM_BYTES_THRESHOLD) {
      setSyncConfirm({ open: true, files: filesToQueue, totalBytes })
      return
    }
    await performSync(filesToQueue)
    ```
  - Extract `performSync(files)` containing the **existing** queue-and-refresh body: `setDeviceSyncState({ deviceSyncing: true })`, `await window.electronAPI.downloadService.queueDownloads(files)`, the existing post-queue refresh/toast logic, the existing `catch` (setError), and the existing `finally { setDeviceSyncState({ deviceSyncing: false }) }`. (Move today's `try/catch/finally` wholesale into `performSync`; `handleSyncAll`'s own try/catch wraps only the read-only reconcile.)
  - Build the dialog description with a human-readable size and an auto-transcribe note. Read `config.transcription.autoTranscribe` from the config store (Device.tsx already reads config for its auto-toggles): 
    ```ts
    const gb = (syncConfirm.totalBytes / 1024 / 1024 / 1024)
    const sizeStr = gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(syncConfirm.totalBytes / 1024 / 1024)} MB`
    const description = `This will download ${syncConfirm.files.length} recordings (~${sizeStr}).` +
      (config?.transcription?.autoTranscribe
        ? ' They will also be transcribed and summarized using your configured AI provider, which may incur usage costs.'
        : '')
    ```
  - Mount the dialog near the end of the Device page JSX (mirror `Library.tsx:1172`):
    ```tsx
    <ConfirmDialog
      open={syncConfirm.open}
      onOpenChange={(open) => setSyncConfirm((prev) => ({ ...prev, open }))}
      title="Download recordings?"
      description={description}
      actionLabel="Download"
      cancelLabel="Cancel"
      variant="default"
      onConfirm={() => {
        const files = syncConfirm.files
        setSyncConfirm((prev) => ({ ...prev, open: false }))
        void performSync(files)
      }}
    />
    ```
  - Add `import { ConfirmDialog } from '@/components/ConfirmDialog'` if not present.
- [ ] **Step 4: Run — PASS** (`npx vitest run src/pages/__tests__/Device.test.tsx; echo RC=$?`) + full typecheck RC 0.
- [ ] **Step 5: Commit.** `fix(electron): confirm before large manual Sync flood (count/size threshold) — protects fresh-device backlog from one-click download+transcribe (auto-pipeline P5 fix)`

---

### Task 3: Close the auto-sync guard race (Defect 3)

**Files:** Modify `src/hooks/useDeviceSubscriptions.ts`; extend `src/hooks/__tests__/useDeviceSubscriptions.test.ts`

⛔ Guard *timing* only — touch nothing in the transfer/listRecordings path.

- [ ] **Step 1: Failing regression test.** Extend `useDeviceSubscriptions.test.ts` with a concurrent-paths test: drive BOTH triggers on one connect — make `checkAutoSyncAllowed` allowed, `waitForConfig`/`waitForDeviceReady` resolve true (Path B fires), AND invoke the captured `onStatusChange({ step: 'ready' })` (Path A schedules its debounce), then advance fake timers past 2 s. Assert `ensureBaseline` (or `getFilesToSync`+`startSession`, depending on the mock's `created` return) is invoked **at most once** — i.e., `runAutoSyncReconcile`'s effects fire a single time, proving the two paths don't both run. (With a `created:false` mock, assert `startSession` called ≤ 1×.)
- [ ] **Step 2: Run — FAIL** (today both paths pass their guards in the window → reconcile runs twice).
- [ ] **Step 3: Implement.** In the status-ready path, move the lock to **schedule time**. Currently (lines ~133-152):
    ```ts
      if (status.step !== 'ready') return
      if (autoSyncTriggeredRef.current) return
      const { allowed, reason } = checkAutoSyncAllowed()
      if (!allowed) { ...; return }
      if (syncDebounceTimerRef.current) { clearTimeout(...) }
      syncDebounceTimerRef.current = setTimeout(async () => {
        autoSyncTriggeredRef.current = true   // <-- LOCK IS HERE (too late)
        ...
    ```
    Change to lock immediately after the guard checks pass, before scheduling:
    ```ts
      if (status.step !== 'ready') return
      if (autoSyncTriggeredRef.current) return
      const { allowed, reason } = checkAutoSyncAllowed()
      if (!allowed) { ...; return }
      // Lock NOW, not inside the debounce — otherwise the pre-connected path
      // (checkInitialAutoSync) can slip through during the 2s window and run a
      // second auto-sync. Reset to false on the listRecordings-failure paths and
      // on disconnect so a genuine retry still works.
      autoSyncTriggeredRef.current = true
      if (syncDebounceTimerRef.current) { clearTimeout(...) }
      syncDebounceTimerRef.current = setTimeout(async () => {
        try { ... }   // remove the now-redundant `autoSyncTriggeredRef.current = true` line
    ```
    Keep the existing `autoSyncTriggeredRef.current = false` resets on the `listRecordings` catch (line ~169) and the disconnect handler (line ~277) — they remain correct (a failed sync re-arms). Path B (`checkInitialAutoSync`) already checks the ref at :249 and will now correctly skip when Path A has locked.
- [ ] **Step 4: Run — PASS** (the new test + all existing `useDeviceSubscriptions` tests; the 4 P5 scenarios must still pass). Full typecheck RC 0.
- [ ] **Step 5: Commit.** `fix(electron): close auto-sync guard race — lock at debounce-schedule so the pre-connected path can't double-run (auto-pipeline P5 fix)`

---

### Task 4: Full gates + re-verification note

- [ ] **Step 1:** `npm run typecheck; echo RC=$?`, `npm run lint 2>&1 | tail -3; echo RC=${PIPESTATUS[0]}`, `npm run test:run > /tmp/fixgate.txt 2>&1; echo RC=$?; grep -E "Test Files|Tests " /tmp/fixgate.txt` — all RC 0 (known WASM flake: re-run once).
- [ ] **Step 2: Evidence:** name the tests proving (a) large manual Sync confirms (Task 2 tests 2-4), (b) small sync silent (test 1), (c) cancel queues nothing (test 3), (d) the two auto-sync paths run reconcile at most once (Task 3 test).
- [ ] **Step 3:** Report. Note for the user: this needs a fresh physical re-test — on the next P1 connect, clicking Sync with the backlog should now show the confirmation first. (The 58 files already queued in the prior session should be cleared first — the user can cancel the active session / the queue is cleared on disconnect.)

## Done criteria
- [ ] Manual Sync of a large batch (> 5 files or > 200 MB) prompts once; confirm downloads all (AC3 preserved), cancel queues nothing.
- [ ] Small syncs proceed without a dialog.
- [ ] Auto-sync runs reconcile at most once per connect (guard race closed), regression-tested.
- [ ] Spec §5.5/AC3 corrected + AC10 added; no transfer-code touched; gates green.

## Explicitly NOT in this fix
- Changing the baseline to apply to manual sync (user chose download-all-but-confirm; AC3 reach preserved).
- A separate "Download backlog" button or per-file transcribe gating (rejected options).
- Any main-process / USB / transfer-code change.
