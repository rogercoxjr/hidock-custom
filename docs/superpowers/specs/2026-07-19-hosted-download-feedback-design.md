# Hosted download feedback (click-confirmation + progress) — design

**Date:** 2026-07-19
**Status:** Approved design → ready for implementation plan
**Scope:** `apps/electron` renderer + `deviceSync` client. Hosted (WebUSB → REST) mode only.

## Problem

Hosted device downloads work (per `apps/electron/docs/deferred-download-work.md`), but give the
user **no feedback**: clicking "DL" / "Download All" / "Sync All" produces no confirmation that
anything started, and no progress during the ~40 s read + chunked upload. Observed live: "no
confirmation that I've clicked or anything has started." This is audit finding #4.

## Goals

- **Instant click confirmation** — the moment a download is triggered, the UI unmistakably shows
  it started (button disables + spinner, row spinner, sidebar appears) *before any bytes move*.
- **Stage + percentage progress** — a stage label ("Reading from device… / Uploading… /
  Saving…") plus a % where meaningful.
- **Both surfaces** — the global sidebar (`OperationsPanel`) **and** the per-recording row
  (`SourceRow` in Library, `DeviceFileRow` in the Device page).
- **Two-level batch progress** — "file N of M" overall plus the current file's stage/%.
- No download should leave the UI stuck in a "syncing" state on success *or* failure.

## Non-goals (deferred — see `deferred-download-work.md`)

- Cancelling an in-progress download.
- Richer error *messages* (threading `{filename, reason}` up, splitting the finalize error) —
  audit #3; this feature only ensures failures clear the UI and fire the existing toasts.
- Fixing the auto-download no-op, the Sync-All count divergence, or server-side hardening.

## Architecture & data flow

The **single source of truth is the existing store**: `deviceSyncState` (`deviceSyncing`,
`deviceSyncProgress {current,total}`, `deviceFileDownloading`, `deviceFileProgress`,
`deviceSyncEta`) plus the `downloadQueue` map. `OperationsPanel` and `SourceRow` already render
from these; the *desktop* path (`useDownloadOrchestrator`) writes them today but is stubbed in
hosted mode, so **the hosted path (`useOperations`) becomes the writer with no conflict.**

Flow for one download:
1. **On trigger (before any bytes):** the handler sets `deviceSyncing: true`,
   `deviceFileDownloading: <filename>`, `deviceFileProgress: 0`, `deviceFileStage: 'reading'`,
   and `addToDownloadQueue(filename, filename, size)` (status `downloading`). → sidebar appears,
   row spinner shows, trigger button disables.
2. **During:** `deviceSync.syncFile(src, onProgress)` emits `{ stage, loaded, total }`;
   `useOperations` maps it to `deviceFileProgress = round(loaded/total*100)` and
   `deviceFileStage = stage`, and updates the active `downloadQueue` item's `progress`.
3. **On settle (per file):** remove the file from `downloadQueue`; increment
   `deviceSyncProgress.current`. **On completion (whole op, in `finally`):**
   `clearDeviceSyncState()`.

Batch: `deviceSyncProgress = { current: filesDone, total: N }` drives the sidebar overall bar +
"file N of M"; the active file's stage/% is the detail line and its row's indicator.

## Progress model

- **Stages:** `reading` (USB read), `uploading` (POST/chunks), `saving` (finalize), `null` (idle).
- **% per phase:** `reading` = bytesRead/size; `uploading` = bytesUploaded/size — for the chunked
  path `(completedChunks·chunkSize + currentChunkBytes)/size` (granular), for the single-POST path
  0 → 100 on completion (fetch exposes no upload progress). The bar resets between phases; the
  stage label keeps it legible ("Reading 100%" → "Uploading 40%").
- **ETA:** reuse the existing `deviceSyncEta` computation where the desktop path already does
  (optional; sidebar already renders it when set).

## Components / units

Each unit has one job and a clear interface:

- **`deviceSync.syncFile` (upload client)** — emits progress. Interface change:
  `onProgress?: (p: { stage: 'reading' | 'uploading' | 'saving'; loaded: number; total: number }) => void`
  (was `(sent: number)`). Emits `reading` from `collectAndHash`, `uploading` during the
  single-POST / per-chunk upload, `saving` before finalize. Existing callers pass no `onProgress`,
  so no breakage.
- **`useOperations` (writer/translator)** — `queueDownload` / `queueBulkDownloads` /
  `syncDeviceFiles` set up `deviceSyncState` + `downloadQueue` on start, translate the
  `onProgress` event into store updates, and clear on completion (already bracket
  `beginDownload/endDownload`). Owns batch counting (`current/total`).
- **store (`useAppStore`)** — add `deviceFileStage: 'reading'|'uploading'|'saving'|null` to
  `deviceSyncState` (+ its setter/clear). `downloadQueue` unchanged.
- **`OperationsPanel` (sidebar renderer)** — add a stage-label line next to the existing %/ETA.
  Read-only consumer.
- **`SourceRow` (Library row renderer)** — already renders `isDownloading` + `downloadProgress`
  (fed by `Library.tsx` from the row's `downloadQueue` item); add the stage label. A row shows the
  stage only when it is the active file (`row.filename === deviceFileDownloading`), using
  `deviceFileStage`; the % comes from its `downloadQueue` item `progress`. Read-only.
- **`DeviceFileRow` / `DeviceFileList` (Device-page row renderer)** — **new:** render a
  spinner + % + stage for the active file using the same rule (match on `deviceFileDownloading`
  for spinner/stage, `downloadQueue` item `progress` for %). Read-only.
- **Buttons** — "Download All" already disables on `downloadQueue.size` (now populated); Device
  "Sync All" and row "DL" disable while `deviceSyncing`.

## Error handling

- A per-file failure (short read/retry-exhausted, chunk/upload error, server 4xx): **remove the
  file from `downloadQueue`** so it doesn't get stuck, let the batch continue (existing
  `syncDeviceFiles` behavior), and fire the existing toast (`queueDownload` toasts the real
  message; `syncDeviceFiles` logs — improving that message is deferred #3). Optionally set the
  row's existing error state (`DeviceFileList.downloadErrors`).
- **Always `clearDeviceSyncState()` in a `finally`** so the sidebar and button never stick on
  success *or* failure; the button re-enables when `deviceSyncing` clears / `downloadQueue`
  empties.
- Re-entrancy: `deviceSyncing` + the download guard already prevent concurrent triggers.
- Navigation mid-download: state is global, so the sidebar persists across pages and the download
  continues; state clears on completion regardless of the current page.

## Testing

- **`syncFile`** emits `onProgress` with `stage:'reading'` (loaded→total) during the read, then
  `stage:'uploading'` during upload — verified for both single-POST and chunked paths; `saving`
  before finalize. Existing client tests (which pass no `onProgress`) still pass.
- **`useOperations`** sets `deviceSyncing` + `downloadQueue` + `deviceFileDownloading` on start,
  updates `deviceFileProgress`/`deviceFileStage` from a simulated `onProgress`, and clears
  `deviceSyncState` + empties the queue on completion — for both success and a thrown failure.
- **Batch**: `deviceSyncProgress` = `{current, total:N}`, `current` increments per file.
- **Renderers**: `OperationsPanel` shows the stage label when `deviceFileStage` is set;
  `SourceRow` / `DeviceFileRow` show spinner+%+stage when the file is the active queue item.
- **Button gating**: trigger button is disabled while `deviceSyncing`/queue is non-empty.

## Success criteria

- Clicking any download control immediately disables the control + shows a spinner and a sidebar
  entry, before any network/USB activity.
- During a download the sidebar and the file's row show a changing stage label and % (granular for
  chunked uploads).
- "Download All" shows "file N of M" + the current file's progress.
- On completion or failure the UI returns to idle (no stuck spinner), and failures still toast.
