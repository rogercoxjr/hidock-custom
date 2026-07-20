# Hosted Download Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give hosted device downloads instant click-confirmation and stage+% progress on the global sidebar and per-recording rows, reusing the existing progress store the desktop path already renders.

**Architecture:** In hosted mode the desktop download path (`useDownloadOrchestrator`) is stubbed, so `useOperations` becomes the writer of the existing `deviceSyncState` + `downloadQueue` store the sidebar (`OperationsPanel`) and rows (`SourceRow`, `DeviceFileList`) already read. `deviceSync.syncFile`'s unused `onProgress` is extended to a structured `{ stage, loaded, total }` event; `useOperations` translates it into store updates. One new store field (`deviceFileStage`) carries the stage label.

**Tech Stack:** React 18 + TypeScript, Zustand (`useAppStore`), Vitest. Work on branch `fix/hosted-device-downloads`. Run all commands from `apps/electron/`.

**Spec:** `docs/superpowers/specs/2026-07-19-hosted-download-feedback-design.md`

---

## File structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/lib/electron-api/types-device-sync.ts` | Shared sync types | Add `SyncProgress` type |
| `src/lib/electron-api/groups/device-sync-client.ts` | Upload client | Emit `SyncProgress` from `syncFile.onProgress` |
| `src/store/useAppStore.ts` | Progress state | Add `deviceFileStage` field + selectors |
| `src/hooks/useOperations.ts` | Download orchestration (hosted) | Write `deviceSyncState`+`downloadQueue`, pass `onProgress` |
| `src/components/layout/OperationsPanel.tsx` | Sidebar renderer | Show stage label |
| `src/features/library/components/SourceRow.tsx` | Library row renderer | Show stage label |
| `src/pages/Library.tsx` | Feeds SourceRow | Pass `downloadStage` |
| `src/components/DeviceFileList.tsx` | Device-page row renderer | Per-row spinner+%+stage |

---

## Task 1: `SyncProgress` type

**Files:**
- Modify: `src/lib/electron-api/types-device-sync.ts`

- [ ] **Step 1: Add the type** (append to the file)

```ts
// Progress event emitted by the upload client (device-sync-client) during syncFile().
// stage: which phase; loaded/total: bytes for that phase (total is the file's declared size).
export interface SyncProgress {
  stage: 'reading' | 'uploading' | 'saving'
  loaded: number
  total: number
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS (no references yet)

- [ ] **Step 3: Commit**

```bash
git add src/lib/electron-api/types-device-sync.ts
git commit -m "feat(electron): add SyncProgress type for staged upload progress"
```

---

## Task 2: `deviceFileStage` store field + selectors

**Files:**
- Modify: `src/store/useAppStore.ts` (state interface ~line 58, setter param ~96, initial ~162, setDeviceSyncState ~289, clearDeviceSyncState ~300, selectors ~415)

- [ ] **Step 1: Add to the state interface** — after the `deviceSyncEta: number | null` line (~58):

```ts
  // Current-file phase label for hosted downloads: 'reading' (USB) | 'uploading' | 'saving' | null (idle)
  deviceFileStage: 'reading' | 'uploading' | 'saving' | null
```

- [ ] **Step 2: Add to the `setDeviceSyncState` param type** — inside the `setDeviceSyncState: (state: {...})` object type (after `deviceSyncEta?: number | null`, ~101):

```ts
    deviceFileStage?: 'reading' | 'uploading' | 'saving' | null
```

- [ ] **Step 3: Add the initial value** — after `deviceSyncEta: null,` (~162):

```ts
  deviceFileStage: null,
```

- [ ] **Step 4: Add to `setDeviceSyncState` body** — after the `deviceSyncEta: ...` line (~289):

```ts
    deviceFileStage: state.deviceFileStage !== undefined ? state.deviceFileStage : prev.deviceFileStage,
```

- [ ] **Step 5: Add to `clearDeviceSyncState` body** — after `deviceSyncEta: null,` (~300):

```ts
    deviceFileStage: null,
```

- [ ] **Step 6: Add selector hooks** — after `export const useDeviceSyncEta = ...` (~415):

```ts
export const useDeviceFileStage = () => useAppStore((s) => s.deviceFileStage)
export const useDeviceFileDownloading = () => useAppStore((s) => s.deviceFileDownloading)
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/store/useAppStore.ts
git commit -m "feat(electron): add deviceFileStage to device-sync store state"
```

---

## Task 3: `syncFile` emits staged `SyncProgress`

**Files:**
- Modify: `src/lib/electron-api/groups/device-sync-client.ts`
- Test: `src/lib/electron-api/groups/__tests__/device-sync-client.test.ts`

- [ ] **Step 1: Write the failing test** — add inside `describe('makeDeviceSyncClient', …)`:

```ts
  it('emits staged progress: reading during collect, uploading during POST, saving before finalize (single-POST)', async () => {
    const stages: string[] = []
    const http = {
      postStream: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { uploadId: 'u1', serverSha256: 'x', bytesReceived: 3 } }),
      post: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { recordingId: 'r1', status: 'synced' } }),
    } as any
    const client = makeDeviceSyncClient({ http })
    await client.syncFile(srcOf([1, 2, 3]), (p) => stages.push(p.stage))
    expect(stages).toContain('reading')
    expect(stages).toContain('uploading')
    expect(stages).toContain('saving')
    expect(stages.indexOf('reading')).toBeLessThan(stages.indexOf('uploading'))
    expect(stages.indexOf('uploading')).toBeLessThan(stages.indexOf('saving'))
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/electron-api/groups/__tests__/device-sync-client.test.ts -t "emits staged progress"`
Expected: FAIL (onProgress currently receives a number, `p.stage` is undefined)

- [ ] **Step 3: Change the `onProgress` type + emit stages** — in `device-sync-client.ts`:

Change the import line to include `SyncProgress`:

```ts
import type { DeviceFileSource, DeviceFileMeta, SyncCreateResponse, SyncFinalizeResponse, SyncProgress } from '../types-device-sync'
```

Change `collectAndHash`'s call site inside `syncFile` and the `syncFile` signature. Replace the `syncFile(src, onProgress)` signature line:

```ts
    async syncFile(src: DeviceFileSource, onProgress?: (p: SyncProgress) => void): Promise<SyncFinalizeResponse> {
```

Replace the `collectAndHash(src, onProgress)` call with a reading-stage wrapper:

```ts
        const { blob, hashHex } = await collectAndHash(src, (sent) =>
          onProgress?.({ stage: 'reading', loaded: sent, total: src.size }))
```

In the **single-POST** branch, wrap the create with uploading events — replace:

```ts
          const created = await http.postStream('/api/recordings/sync', blob, { 'x-device-file': header })
          if (!created.ok) {
            lastErr = created.error ?? `HTTP ${created.status}`
            continue
          }
          uploadId = (created.data as SyncCreateResponse).uploadId
```

with:

```ts
          onProgress?.({ stage: 'uploading', loaded: 0, total: src.size })
          const created = await http.postStream('/api/recordings/sync', blob, { 'x-device-file': header })
          if (!created.ok) {
            lastErr = created.error ?? `HTTP ${created.status}`
            continue
          }
          onProgress?.({ stage: 'uploading', loaded: src.size, total: src.size })
          uploadId = (created.data as SyncCreateResponse).uploadId
```

In the **chunked** branch, replace the existing per-chunk progress line:

```ts
            onProgress?.(Math.min(offset + chunkSize, blob.size))
```

with:

```ts
            onProgress?.({ stage: 'uploading', loaded: Math.min(offset + chunkSize, blob.size), total: blob.size })
```

Finally, emit `saving` immediately before the finalize POST — insert directly above `const fin = await http.post(...finalize...)`:

```ts
        onProgress?.({ stage: 'saving', loaded: src.size, total: src.size })
```

- [ ] **Step 4: Run the test to verify it passes + no regressions**

Run: `npx vitest run src/lib/electron-api/groups/__tests__/device-sync-client.test.ts`
Expected: PASS (all tests, including the new staged-progress one and the existing chunked/short-read tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/electron-api/groups/device-sync-client.ts src/lib/electron-api/groups/__tests__/device-sync-client.test.ts
git commit -m "feat(electron): syncFile emits staged reading/uploading/saving progress"
```

---

## Task 4: `useOperations` writes progress state (the core wiring)

**Files:**
- Modify: `src/hooks/useOperations.ts` (add `useAppStore` import; add a `syncOne` helper; rewire `queueDownload`, `queueBulkDownloads`, `syncDeviceFiles`)
- Test: `src/hooks/__tests__/useOperations.syncDeviceFiles.test.ts`

- [ ] **Step 1: Write the failing test** — add inside `describe('useOperations.syncDeviceFiles', …)`:

```ts
  it('drives deviceSyncState + downloadQueue during a sync and clears on completion', async () => {
    const { useAppStore } = await import('@/store/useAppStore')
    const seen: Array<{ stage: unknown; queued: boolean; syncing: boolean }> = []
    // Capture store state while syncFile is "in flight".
    syncFile.mockImplementationOnce(async (_src: any, onProgress?: (p: any) => void) => {
      onProgress?.({ stage: 'reading', loaded: 3, total: 3 })
      const s = useAppStore.getState()
      seen.push({ stage: s.deviceFileStage, queued: s.downloadQueue.has('A.hda'), syncing: s.deviceSyncing })
      return { recordingId: 'r1', status: 'synced' }
    })
    const { result } = renderHook(() => useOperations())
    await act(async () => { await result.current.syncDeviceFiles([{ filename: 'A.hda', size: 3 }]) })

    expect(seen[0]).toEqual({ stage: 'reading', queued: true, syncing: true }) // live: stage+queue+syncing set
    const after = useAppStore.getState()
    expect(after.deviceSyncing).toBe(false)          // cleared on completion
    expect(after.downloadQueue.has('A.hda')).toBe(false)
    expect(after.deviceFileStage).toBeNull()
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/hooks/__tests__/useOperations.syncDeviceFiles.test.ts -t "drives deviceSyncState"`
Expected: FAIL (`syncDeviceFiles` doesn't touch the store yet — `seen[0]` is all false/null)

- [ ] **Step 3: Add the store import** — after the existing `import { beginDownload, endDownload } from '@/services/download-guard'` line:

```ts
import { useAppStore } from '@/store/useAppStore'
import type { SyncFinalizeResponse } from '@/lib/electron-api/types-device-sync'
```

- [ ] **Step 4: Add the `syncOne` helper** — inside `useOperations()`, above `queueDownload` (after the `queueBulkTranscriptions`/download section comment):

```ts
  // Per-file sync + live progress into the shared store (sidebar + rows read this).
  // Does NOT own the aggregate (deviceSyncing/deviceSyncProgress) or the guard — callers do.
  const syncOne = useCallback(async (filename: string, size: number): Promise<SyncFinalizeResponse | null> => {
    const store = useAppStore.getState()
    store.addToDownloadQueue(filename, filename, size)               // instant: row spinner + button gate
    store.setDeviceSyncState({ deviceFileDownloading: filename, deviceFileProgress: 0, deviceFileStage: 'reading' })
    try {
      const src = hostedApi().downloadService.deviceFileSource(filename, size)
      const res = await hostedApi().deviceSync.syncFile(src, (p) => {
        const pct = p.total > 0 ? Math.round((p.loaded / p.total) * 100) : 0
        const s = useAppStore.getState()
        s.updateDownloadProgress(filename, pct)
        s.setDeviceSyncState({ deviceFileProgress: pct, deviceFileStage: p.stage })
      })
      return res
    } catch (e) {
      console.error('Failed to sync device file:', filename, e instanceof Error ? e.message : 'Unknown error')
      return null
    } finally {
      useAppStore.getState().removeFromDownloadQueue(filename)
    }
  }, [])
```

- [ ] **Step 5: Rewrite `queueDownload`** — replace the whole `queueDownload` useCallback body with:

```ts
  const queueDownload = useCallback(async (recording: UnifiedRecording) => {
    if (!isDeviceOnly(recording)) return false
    beginDownload()
    useAppStore.getState().setDeviceSyncState({ deviceSyncing: true, deviceSyncProgress: { current: 0, total: 1 } })
    try {
      const res = await syncOne(recording.deviceFilename, recording.size)
      useAppStore.getState().setDeviceSyncState({ deviceSyncProgress: { current: 1, total: 1 } })
      toast(res
        ? { title: res.status === 'skipped' ? 'Already synced' : 'Synced', description: recording.filename }
        : { title: 'Sync failed', description: recording.filename, variant: 'error' })
      return res != null
    } finally {
      useAppStore.getState().clearDeviceSyncState()
      endDownload()
    }
  }, [syncOne])
```

- [ ] **Step 6: Rewrite `queueBulkDownloads`** — replace its body with:

```ts
  const queueBulkDownloads = useCallback(async (recordings: UnifiedRecording[]) => {
    const eligible = recordings.filter(isDeviceOnly)
    if (eligible.length === 0) return 0
    beginDownload()
    useAppStore.getState().setDeviceSyncState({ deviceSyncing: true, deviceSyncProgress: { current: 0, total: eligible.length } })
    try {
      let done = 0
      for (let i = 0; i < eligible.length; i++) {
        if (await syncOne(eligible[i].deviceFilename, eligible[i].size)) done++
        useAppStore.getState().setDeviceSyncState({ deviceSyncProgress: { current: i + 1, total: eligible.length } })
      }
      if (done) toast({ title: `${done} recording${done > 1 ? 's' : ''} synced` })
      return done
    } finally {
      useAppStore.getState().clearDeviceSyncState()
      endDownload()
    }
  }, [syncOne])
```

- [ ] **Step 7: Rewrite `syncDeviceFiles`** — replace its body with:

```ts
  const syncDeviceFiles = useCallback(async (files: Array<{ filename: string; size: number }>) => {
    if (files.length === 0) return 0
    beginDownload()
    useAppStore.getState().setDeviceSyncState({ deviceSyncing: true, deviceSyncProgress: { current: 0, total: files.length } })
    try {
      let synced = 0
      for (let i = 0; i < files.length; i++) {
        if (await syncOne(files[i].filename, files[i].size)) synced++
        useAppStore.getState().setDeviceSyncState({ deviceSyncProgress: { current: i + 1, total: files.length } })
      }
      return synced
    } finally {
      useAppStore.getState().clearDeviceSyncState()
      endDownload()
    }
  }, [syncOne])
```

- [ ] **Step 8: Run the useOperations tests to verify pass**

Run: `npx vitest run src/hooks/__tests__/useOperations.syncDeviceFiles.test.ts src/hooks/__tests__/useOperations.sync.test.ts src/hooks/__tests__/useOperations.test.ts`
Expected: PASS (new store test + existing count/error/guard tests)

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/hooks/useOperations.ts src/hooks/__tests__/useOperations.syncDeviceFiles.test.ts
git commit -m "feat(electron): hosted downloads write live progress to the device-sync store"
```

---

## Task 5: Sidebar stage label (`OperationsPanel`)

**Files:**
- Modify: `src/components/layout/OperationsPanel.tsx`

- [ ] **Step 1: Add the selector imports** — change the store import line (~5) to:

```ts
import { useDownloadQueue, useDeviceSyncProgress, useDeviceSyncEta, useDeviceFileStage, useDeviceFileDownloading } from '@/store/useAppStore'
```

- [ ] **Step 2: Read the values + a label map** — after `const deviceSyncEta = useDeviceSyncEta()` (~26):

```ts
  const deviceFileStage = useDeviceFileStage()
  const deviceFileDownloading = useDeviceFileDownloading()
  const STAGE_LABEL: Record<'reading' | 'uploading' | 'saving', string> = {
    reading: 'Reading from device…', uploading: 'Uploading…', saving: 'Saving…',
  }
```

- [ ] **Step 3: Render the stage line** — inside the overall-progress block, immediately after the `deviceSyncEta != null && …` block (~153), still inside the `deviceSyncProgress && deviceSyncProgress.total > 0` wrapper, add:

```tsx
                  {deviceFileStage && deviceFileDownloading && (
                    <div className="text-[10px] text-ink-muted mt-0.5 truncate" title={deviceFileDownloading}>
                      {STAGE_LABEL[deviceFileStage]} {deviceFileDownloading}
                    </div>
                  )}
```

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck:web && npm run lint 2>&1 | grep -c error`
Expected: typecheck PASS; `0` errors

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/OperationsPanel.tsx
git commit -m "feat(electron): show download stage label in the operations sidebar"
```

---

## Task 6: Per-row stage label (`SourceRow` + `Library`)

**Files:**
- Modify: `src/features/library/components/SourceRow.tsx` (props ~73, memo destructure ~104, indicator ~230, memo comparator ~379)
- Modify: `src/pages/Library.tsx` (selectors ~74, three `<SourceRow>` call sites ~1097, ~1147, ~1251)

- [ ] **Step 1: Add the `downloadStage` prop type** — after `downloadProgress?: number` (~73):

```ts
  downloadStage?: 'reading' | 'uploading' | 'saving' | null
```

- [ ] **Step 2: Destructure it** — after `downloadProgress,` in the component signature (~104):

```ts
  downloadStage,
```

- [ ] **Step 3: Render it in the indicator** — replace the existing downloading indicator block (~230):

```tsx
        {/* Downloading in-progress indicator */}
        {isDownloading && (
          <div className="flex items-center gap-1 text-xs text-ink-muted px-1">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            <span>
              {downloadStage ? { reading: 'Reading', uploading: 'Uploading', saving: 'Saving' }[downloadStage] + ' ' : ''}
              {downloadProgress ?? 0}%
            </span>
          </div>
        )}
```

- [ ] **Step 4: Add `downloadStage` to the memo comparator** — after `prevProps.downloadProgress === nextProps.downloadProgress &&` (~379):

```ts
    prevProps.downloadStage === nextProps.downloadStage &&
```

- [ ] **Step 5: Add selectors in `Library.tsx`** — change the store import (~18) and add the reads near `const downloadQueue = useDownloadQueue()` (~74):

```ts
import { useDownloadQueue, useDeviceFileStage, useDeviceFileDownloading } from '@/store/useAppStore'
```
```ts
  const deviceFileStage = useDeviceFileStage()
  const deviceFileDownloading = useDeviceFileDownloading()
```

- [ ] **Step 6: Pass `downloadStage` at all three `<SourceRow>` call sites** — after each `downloadProgress={…}` prop (the two list rows ~1099/1149 and the reader ~1254), add:

```tsx
                          downloadStage={
                            isDeviceOnly(recording) && deviceFileDownloading === recording.deviceFilename ? deviceFileStage : undefined
                          }
```

(For the `selectedRecording` reader call site ~1254, use `selectedRecording` in place of `recording`.)

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/features/library/components/SourceRow.tsx src/pages/Library.tsx
git commit -m "feat(electron): show download stage label on Library recording rows"
```

---

## Task 7: Per-row progress on the Device page (`DeviceFileList`)

**Files:**
- Modify: `src/components/DeviceFileList.tsx` (imports; `DeviceFileRowProps` ~60; main component reads ~174; `<DeviceFileRow>` render props ~383; `DeviceFileRow` Actions block ~156)

- [ ] **Step 1: Add imports + a spinner icon** — add `RefreshCw` to the lucide import (~8) and the store selectors near the existing `useIsDownloading`/`useDownloadProgress` imports (~26):

```ts
import { Download, Trash2, AlertCircle, CheckCircle, HardDrive, Volume2, ChevronUp, ChevronDown, Mic, RefreshCw } from 'lucide-react'
import { useIsDownloading, useDownloadProgress } from '@/store/useAppStore'
import { useDownloadQueue, useDeviceFileStage, useDeviceFileDownloading } from '@/store/useAppStore'
```

- [ ] **Step 2: Add row props** — in `DeviceFileRowProps` (~60), after `onDownload: (filename: string, fileSize: number) => void`:

```ts
  isDownloading?: boolean
  downloadProgress?: number
  downloadStage?: 'reading' | 'uploading' | 'saving' | null
```

- [ ] **Step 3: Destructure them in `DeviceFileRow`** — wherever the row destructures its props (the `function DeviceFileRow({ … })` signature), add `isDownloading = false, downloadProgress, downloadStage,`.

- [ ] **Step 4: Render spinner+%+stage instead of the DL button while downloading** — replace the `showDownloadButton && (…DL button…)` block in the Actions area (~157) with:

```tsx
        {isDownloading ? (
          <div className="flex items-center gap-1 text-xs text-ink-muted px-1">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            <span>
              {downloadStage ? { reading: 'Reading', uploading: 'Uploading', saving: 'Saving' }[downloadStage] + ' ' : ''}
              {downloadProgress ?? 0}%
            </span>
          </div>
        ) : showDownloadButton && (
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
            onClick={() => onDownload(filename, recording.size)}>
            <Download className="h-3 w-3 mr-1" />
            DL
          </Button>
        )}
```

- [ ] **Step 5: Feed the props from the list** — in `DeviceFileList()` (~174) add the store reads:

```ts
  const downloadQueue = useDownloadQueue()
  const deviceFileStage = useDeviceFileStage()
  const deviceFileDownloading = useDeviceFileDownloading()
```

Then at the `<DeviceFileRow … />` render (~383), pass:

```tsx
                isDownloading={downloadQueue.has(recording.deviceFilename)}
                downloadProgress={downloadQueue.get(recording.deviceFilename)?.progress}
                downloadStage={deviceFileDownloading === recording.deviceFilename ? deviceFileStage : undefined}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/components/DeviceFileList.tsx
git commit -m "feat(electron): per-row download progress + stage on the Device page"
```

---

## Task 8: Full verification

- [ ] **Step 1: Run the whole affected test set**

Run: `npx vitest run src/lib/electron-api/groups/__tests__/device-sync-client.test.ts src/hooks/__tests__/useOperations.syncDeviceFiles.test.ts src/hooks/__tests__/useOperations.sync.test.ts src/hooks/__tests__/useUnifiedRecordings.test.ts src/services/__tests__/download-guard.test.ts`
Expected: PASS

- [ ] **Step 2: Full typecheck (both configs)**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Lint (0 errors)**

Run: `npm run lint 2>&1 | tail -1`
Expected: `✖ N problems (0 errors, N warnings)` — 0 errors

- [ ] **Step 4: Commit any final fixups, then deploy for live verification**

Deploy is a hotpatch (see `apps/electron/docs/deferred-download-work.md` / the `hosted-hub-deployment` memory): rebuild `out/renderer` (`npm run build`), `docker cp` into `hidock-hub`, `docker restart`. Then click "DL" on a recording and confirm: the button/row shows a spinner immediately, the sidebar shows the stage label + %, and a large file shows "Reading… → Uploading… (granular)". This feature ships together with the permanent image rebuild + container cutover (deferred item in the tracker), so the hub restarts once for both.

---

## Notes for the implementer

- `downloadQueue` is keyed by the **device filename** (that's what `Library.tsx` and `DeviceFileList` look up), so `syncOne` uses `filename` as the queue id. Keep that consistent.
- `useOperations` intentionally reads/writes the store via `useAppStore.getState()` (not hook selectors) so its callbacks don't add re-render dependencies — mirror the existing `useDownloadOrchestrator` pattern.
- Do NOT wire cancellation, richer error messages, or the auto-download fix here — those are deferred (`deferred-download-work.md`).
