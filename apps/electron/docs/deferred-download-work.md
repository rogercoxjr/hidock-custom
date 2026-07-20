# Deferred download/sync work

Backlog of items discussed but intentionally deferred while fixing hosted-hub device
downloads (2026-07-19). Fixes already shipped live on branch `fix/hosted-device-downloads`
(4 commits): DL routing fix, integrity hardening (short-read/cross-resolve/overshoot/size-0),
Tier-1 concurrency guard, and chunked upload. See `apps/electron/docs/DEPLOY-UNRAID.md` /
`DEPLOY-NPM.md` for the hosting topology (Cloudflare ~100 MB upload cap is why chunking exists).

## Shipped on this branch (2026-07-19/20)
- **Download click-confirmation + progress indicators.** DONE. `syncFile` now emits
  `SyncProgress {stage, loaded, total}` (reading→uploading→saving); `useOperations` maps it to
  `deviceSyncState` + `downloadQueue`; rendered as stage label **+** percentage in the sidebar
  (`OperationsPanel`) and per-row (`SourceRow`/`SourceCard`/`SourceReader`/`DeviceFileList`), with
  the trigger button swapping to a spinner on click and two-level batch progress (file N of M +
  current file's stage/%). No cancel (still deferred, below). Spec/plan under
  `docs/superpowers/specs|plans/2026-07-19-hosted-download-feedback*`.
- **Concurrency gate (device safety).** DONE. Every download-START control is `disabled` while
  `deviceSyncing` is true so a second `syncFile` can't collide on the shared USB read loop:
  SourceRow/SourceCard/SourceReader, DeviceFileList per-row + batch, LibraryHeader "Download All",
  Calendar bulk + card-row + list-row, and BulkActionsBar (via `disabledActions.download`).
  Device "Sync all" flips to Cancel while syncing. Regression-guarded by
  `SourceCard.deviceSyncing.test.tsx`.

## Minor cleanups (deferred, low priority)
- **Dead store field `deviceFileProgress`.** Written (`useOperations.ts`, `Device.tsx`,
  `useDownloadOrchestrator.ts`) but never read — per-file % surfaces through the `downloadQueue`
  Map via `useDownloadProgress(id)`. Pre-existing; safe to remove the writes + field.
- **Shared `@/store/useAppStore` test mock.** Five suites hand-roll the same `vi.mock` factory
  (Library, Device, library-a11y, library-performance, OperationsPanel); a new store export
  silently breaks all of them (it did this branch). Extract one shared mock helper (or use
  `vi.importActual` + partial override) so exports can't drift.

## Deferred features
- **Cancel an in-progress download/batch.** Explicitly deferred. Needs an `AbortController`
  wired through `syncFile → deviceFileSource → downloadFile` (which already accepts a signal but
  the hosted path passes none) plus aborting the in-flight upload fetch. Touches the sensitive
  USB read path — its own feature.

## Audit follow-ups (from the `download-issues-audit` workflow — verified, ranked)
Not blockers; downloads work. Ordered by leverage.

1. **Auto-download is a silent no-op in hosted mode** (`useDeviceSubscriptions.ts:44`). On
   device-ready it reconciles via the stubbed `downloadService.getFilesToSync` → returns `[]` →
   logs "All files synced / No new recordings to download" even with new device-only files.
   Fix: route auto-sync through `deviceSync.syncFile` like `Device.tsx handleSyncAll`.
2. **"Sync All" count vs action divergence** (`Device.tsx:1167`). Button count comes from
   `deviceState.recordingCount - syncedFilenames.size`; the action syncs `recordings.filter(isDeviceOnly)`.
   When the live file-list fetch fails silently, the button shows "Sync N" but does nothing.
   Fix: drive count from the same collection the action uses; surface the swallowed list error.
3. **Error surfacing** — `syncDeviceFiles` drops per-file errors to `console.error`
   (`useOperations.ts:219`); `performSync`'s toast is a generic "No recordings were downloaded"
   (`Device.tsx:517`); finalize's "integrity check failed" conflates SHA vs byte-count vs
   missing-checksum (`device-sync.ts`). Fix: thread `{filename, reason}` up and split the
   finalize error into distinct messages.
4. **Empty-selection bulk download is a silent no-op** (`useOperations.ts` `queueBulkDownloads`
   only toasts when `done>0`). Toast the empty-eligible case (mirror `queueBulkTranscriptions`).
5. **Server large-import streaming** (`recordings.ts:204`). The `/api/recordings/upload` route
   `Buffer.concat`s the whole multipart file (~2× transient RAM). Stream to disk like
   `saveRecordingFromPath` (device-sync already does).
6. **Client 3× buffering** in `collectAndHash` (`device-sync-client.ts`) — holds chunks[] +
   concatenated bytes + Blob simultaneously; fine at ~150 MB, not for multi-GB. Longer term:
   streaming SHA-256 so the file isn't held whole.
7. **Server hygiene** — partfile writes ignore backpressure (`partfile-store.ts:41`); the raw
   `/api/recordings/sync` stream has no byte cap (pass-through parser bypasses `bodyLimit`); the
   in-memory `finished`/`open` upload maps leak entries for un-finalized uploads (no periodic
   sweep — `sweepExpiredParts` only touches disk, at boot). Add pause/drain, a size ceiling, and
   a timestamped map sweep.
8. **`downloadFile` inactivity timeout** (`jensen.ts`) — it's the only Jensen command with no
   timeout; a stalled device could hang a sync. Add an idle watchdog that rejects (mirroring
   `getFileList`'s 120s race). Mitigated in practice by the Tier-1 guard + short-read guard, but
   still worth a real timeout. Needs hardware to validate.
9. **`isConnected()` liveness** (`jensen.ts:464`) — checks `device !== null`, not
   `device.opened`; a stale handle after a failed reset can block reconnect. Add `&& device.opened`
   and null the handle on reset failure. Needs a device to exercise the reset→reconnect path.

## Ops
- **Cut over to the rebuilt image.** The 4 shipped fixes currently run as a hotpatch in the live
  container (reverts on next `docker compose pull`). A permanent image
  (`rogercoxjr/hidock-hub:latest`, id `92f957a6…`) is already built on the server; rollback ref
  is the prior id `82414c3c…`. **Cutover (container recreate) is deferred to bundle with the
  progress-UI feature** so the hub restarts once, not twice.
