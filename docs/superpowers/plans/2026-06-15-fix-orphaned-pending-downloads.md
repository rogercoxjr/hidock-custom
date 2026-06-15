# Fix Orphaned Pending Downloads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. TDD throughout: failing test first, watch it fail, minimal code to green.

**Goal:** Pending downloads can never be silently orphaned: they reliably start when the device is ready or when the user syncs, abandoned prior-session pending items are cleared on startup, and the user can clear queued-but-not-started items from the UI.

**Architecture:** Three small, decoupled fixes in the existing download orchestration. No USB-transfer code is touched (the WebUSB `transferIn` path in `hidock-device.ts`/`jensen.ts` is OFF-LIMITS). All triggering happens at the already-documented *safe* points (device `'ready'` = file-list scan complete + bus free; user-initiated sync). `processDownloadQueue` already self-guards (`isProcessingDownloads` lock set before first await + `deviceService.isConnected()` check), so adding extra callers is concurrency-safe.

**Tech Stack:** Electron 39 main process (TS), React 18 renderer (TS), Zustand, Vitest + Testing Library. Run gates from `apps/electron`: `npm run typecheck && npm run lint && npm run test:run`.

---

## Root Cause (for context)

A `pending` download is started by exactly ONE path: the opportunistic gate inside `useDownloadOrchestrator`'s `onStateUpdate` (`src/hooks/useDownloadOrchestrator.ts:377`), which fires `processDownloadQueue()` only if `connectionStatus.step === 'ready'` AND `!isProcessingDownloads` at the instant a download-service state update arrives. The device-`ready` handler (`:394`) only retries `failed` items, never `pending`. `performSync` (`src/pages/Device.tsx`) only calls `queueDownloads` and relies on that opportunistic gate. The startup loader (`download-service.ts loadQueueFromDatabase`, `:142`) reloads prior-session `pending` rows but the stale-cleanup (`:182`) only purges pending items that have a `started_at` — never-started items have `started_at = null` and so reload forever. Net: manually-queued / persisted-pending items can be permanently stuck "queued" with nothing to start them.

**Design decision (confirm with user):** abandoned prior-session `pending`/`downloading` rows are *cleared* on startup rather than auto-resumed. This matches the product goal ("no surprise/backlog downloads") and means a mid-sync app kill requires a re-sync (resume never actually worked anyway).

---

## File Structure

- `apps/electron/electron/main/services/download-service.ts`
  - Modify `loadQueueFromDatabase` (~:142) — clear abandoned `pending`/`downloading` on startup (Task 2).
  - Add `cancelPendingDownloads(reason?)` method (Task 3) near `cancelActiveDownloads` (~:773).
- `apps/electron/electron/preload/index.ts` — add `cancelPendingDownloads` to the typed API + bridge (Task 3).
- `apps/electron/electron/main/ipc/` (download IPC handler module) — register `download-service:cancel-pending` (Task 3).
- `apps/electron/src/hooks/useDownloadOrchestrator.ts`
  - Device-`ready` handler (~:394): also start pending, not only failed (Task 1).
  - Export module-level `processPendingDownloads()` mirroring `cancelDownloads` (Task 1b).
- `apps/electron/src/pages/Device.tsx` — `performSync` (~:463) calls `processPendingDownloads()` after a successful queue; add a "Clear queue" affordance for pending items (Task 1b + Task 3).
- Tests: `download-service.test.ts`, `useDownloadOrchestrator.test.ts`, `Device.test.tsx`.

---

## Task 1: Device-ready handler starts pending downloads

**Files:**
- Modify: `apps/electron/src/hooks/useDownloadOrchestrator.ts:394-411`
- Test: `apps/electron/src/hooks/__tests__/useDownloadOrchestrator.test.ts`

- [ ] **Step 1: Failing test** — when device status becomes `'ready'` and the download-service state has a `pending` item and `isProcessingDownloads` is false, the orchestrator calls `processDownloadQueue` (assert via the mocked `downloadService.getState` returning a pending item + spying that the USB/get-state→process path runs; follow the existing `renderHook` + mocked `window.electronAPI.downloadService` idiom already in this test file). Add a second test: when state has only `failed` items, `retryFailed` is called (existing behavior preserved).

- [ ] **Step 2: Run test, watch it fail** — `cd apps/electron && npx vitest run src/hooks/__tests__/useDownloadOrchestrator.test.ts`. Expect FAIL (pending path not yet wired).

- [ ] **Step 3: Implement** — in the `onStatusChange` handler, extend the `status.step === 'ready'` branch so that after the existing `hasFailed`/`retryFailed` logic it also checks pending:

```ts
window.electronAPI.downloadService.getState().then((state) => {
  const hasFailed = state.queue.some((item: DownloadQueueItem) => item.status === 'failed')
  const hasPending = state.queue.some((item: DownloadQueueItem) => item.status === 'pending')
  if (hasFailed) {
    if (shouldLogQa()) console.log('[useDownloadOrchestrator] Device ready, retrying failed downloads')
    window.electronAPI.downloadService.retryFailed(true)
  }
  // FIX: 'ready' means the file-list scan is complete and the USB bus is free —
  // the safe point to drain pending items that no longer have a live trigger.
  if (hasPending && !isProcessingDownloads.current) {
    if (shouldLogQa()) console.log('[useDownloadOrchestrator] Device ready, starting pending downloads')
    processDownloadQueueRef.current()
  }
})
```

- [ ] **Step 4: Run test, watch it pass.** Re-run the file. Other orchestrator tests stay green.

- [ ] **Step 5: Commit** — `test(electron): orchestrator starts pending downloads on device-ready, not just failed`

---

## Task 1b: Manual sync reliably triggers processing

**Files:**
- Modify: `apps/electron/src/hooks/useDownloadOrchestrator.ts` (module-level export, near `cancelDownloads`)
- Modify: `apps/electron/src/pages/Device.tsx:463-501` (`performSync`)
- Test: `apps/electron/src/pages/__tests__/Device.test.tsx`

- [ ] **Step 1: Failing test** — in `Device.test.tsx`, after `performSync`/Sync queues files (`mockQueueDownloads` resolves with ids), assert the exported `processPendingDownloads` is invoked. Mock `@/hooks/useDownloadOrchestrator` to expose a spy `processPendingDownloads` (the test file already mocks `queueDownloads`; extend the mock).

- [ ] **Step 2: Run test, watch it fail** — `npx vitest run src/pages/__tests__/Device.test.tsx`. Expect FAIL.

- [ ] **Step 3: Implement.** In `useDownloadOrchestrator.ts`, add a module-level ref + export mirroring the `cancelDownloads` pattern. Assign the ref where `processDownloadQueueRef` is set (~:316):

```ts
// module scope (near _downloadAbortControllerRef / _cancelInProgress)
let _processQueueRef: React.MutableRefObject<() => Promise<void>> | null = null

/** Imperatively start processing any pending downloads. Safe: processDownloadQueue
 *  self-guards on isProcessing + deviceService.isConnected(). */
export function processPendingDownloads(): void {
  _processQueueRef?.current?.()
}

// inside the hook, right after `processDownloadQueueRef.current = processDownloadQueue`
_processQueueRef = processDownloadQueueRef
```

In `Device.tsx`, import it (`import { cancelDownloads, processPendingDownloads } from '@/hooks/useDownloadOrchestrator'`) and call it after a successful queue in `performSync`:

```ts
if (queuedIds.length > 0) {
  await refreshSyncedFilenames()
  processPendingDownloads() // FIX: don't rely on the opportunistic onStateUpdate gate
  toast({ title: 'Sync started', /* …unchanged… */ })
}
```

- [ ] **Step 4: Run test, watch it pass.** Re-run Device.test.tsx; keep other Device tests green.

- [ ] **Step 5: Commit** — `fix(electron): manual sync explicitly starts pending downloads (no reliance on opportunistic gate)`

---

## Task 2: Clear abandoned pending/downloading on startup

**Files:**
- Modify: `apps/electron/electron/main/services/download-service.ts:142-202` (`loadQueueFromDatabase`)
- Test: `apps/electron/electron/main/services/__tests__/download-service.test.ts`

- [ ] **Step 1: Failing test** — seed `download_queue` with a `pending` row whose `started_at` is NULL and a `downloading` row, construct the service, assert: (a) neither is present in the in-memory queue, (b) both removed from DB (`SELECT … WHERE status IN ('pending','downloading')` returns 0), (c) `completed`/`failed` rows are untouched. Use the existing real-DB fixture idiom in this test file.

- [ ] **Step 2: Run test, watch it fail** — `npx vitest run electron/main/services/__tests__/download-service.test.ts`. Expect FAIL (current loader keeps them).

- [ ] **Step 3: Implement.** Replace the `started_at`-gated stale-clear with: on load, treat ALL persisted `pending`/`downloading` rows as abandoned (there is never a live session at construction time) — remove them from the in-memory map AND the DB, and log the count. Keep loading `completed`/`failed` rows for history/retry as before (the SELECT already filters to pending/downloading, so the simplest correct change is: load them, then immediately clear every loaded row and delete it from the DB).

```ts
// after building queueItems from the pending/downloading SELECT:
const abandoned = [...this.state.queue.keys()]
for (const key of abandoned) {
  this.state.queue.delete(key)
  this.removeFromDatabase(key)
}
this.markDirty()
console.log(`[DownloadService] Cleared ${abandoned.length} abandoned pending/downloading item(s) from previous session`)
```

(Delete the now-dead `STALE_THRESHOLD_MS` block.)

- [ ] **Step 4: Run test, watch it pass.** Re-run the file + `download-service-b007/c004` tests stay green.

- [ ] **Step 5: Commit** — `fix(electron): clear abandoned pending/downloading downloads on startup (prevents orphaned-forever queue items)`

---

## Task 3: Clear-queue method, IPC, and UI affordance

**Files:**
- Modify: `apps/electron/electron/main/services/download-service.ts` (add `cancelPendingDownloads`)
- Modify: `apps/electron/electron/preload/index.ts` (type + bridge)
- Modify: download IPC handler module that registers `download-service:*` (add `cancel-pending`)
- Modify: `apps/electron/src/pages/Device.tsx` (Clear-queue button, visible when pending > 0 and not actively syncing)
- Tests: `download-service.test.ts`, `Device.test.tsx`

- [ ] **Step 1: Failing test (service)** — `cancelPendingDownloads()` removes all `pending` items from the in-memory queue and DB, leaves `downloading`/`completed` untouched, returns the count, and emits a state update. Write + watch fail.

- [ ] **Step 2: Implement service method** (near `cancelActiveDownloads`, ~:797):

```ts
/** Remove all not-yet-started (pending) downloads from the queue + DB. Returns count cleared. */
cancelPendingDownloads(): number {
  const keys: string[] = []
  for (const [key, item] of this.state.queue) if (item.status === 'pending') keys.push(key)
  for (const key of keys) { this.state.queue.delete(key); this.removeFromDatabase(key) }
  if (keys.length > 0) { this.markDirty(); this.emitStateUpdate(true) }
  return keys.length
}
```
Run service test → green.

- [ ] **Step 3: Wire IPC + preload.** Register `ipcMain.handle('download-service:cancel-pending', () => downloadService.cancelPendingDownloads())` in the same module as the other `download-service:*` handlers; add `cancelPendingDownloads: () => Promise<number>` to the preload type and `cancelPendingDownloads: () => callIPC('download-service:cancel-pending')` to the bridge. Typecheck.

- [ ] **Step 4: Failing test (UI)** — in `Device.test.tsx`, render with a pending queue and `deviceSyncing=false`; assert a "Clear queue" control is present and clicking it calls `cancelPendingDownloads`. Watch fail.

- [ ] **Step 5: Implement UI.** Add a small "Clear queue" button near the download/queue area in `Device.tsx`, shown when there are pending items and no active sync; on click call `window.electronAPI.downloadService.cancelPendingDownloads()` then `clearDownloadQueue()` (store) and toast the cleared count. Test → green.

- [ ] **Step 6: Commit** — `feat(electron): clear queued-but-not-started downloads from the Device UI`

---

## Final Verification

- [ ] `cd apps/electron && npm run typecheck` → 0 errors
- [ ] `npm run lint` → 0 new errors
- [ ] `npm run test:run` → all green (note baseline count before/after)
- [ ] Dispatch a final code-reviewer subagent over the whole branch diff (separate review lane; confirm USB-transfer code untouched, concurrency lock reasoning sound, no resume-semantics regressions beyond the documented decision).
- [ ] Remove the 5 `apps/electron/_*.cjs` debug scripts.

## Self-Review notes
- Concurrency: every new `processDownloadQueue` caller is safe because `isProcessingDownloads.current` is set synchronously before the first await (DL-008) and the function re-checks `deviceService.isConnected()`.
- USB safety: no change to `hidock-device.ts`, `jensen.ts`, or any `transferIn` code. Triggers only fire at `'ready'` (post-scan) or on explicit user sync.
- Method-name consistency: `processPendingDownloads` (renderer export), `cancelPendingDownloads` (service/IPC), `download-service:cancel-pending` (channel).
