# Hosted Hub — Phase 1: Browser Device Sync (design)

- **Date:** 2026-07-06
- **Status:** Design approved; ready for implementation planning
- **Predecessor:** Phase 0 (hosted knowledge hub) — complete and deployed. See
  `2026-06-25-hosted-knowledge-hub-design.md` §10 for the phase roadmap.
- **Goal:** Implement all of Phase 1 (the #1 headline feature: get recordings
  off the HiDock into the hosted hub via the browser), built by multiple
  subagents in parallel, ending in a single human-driven live smoke test.

## 1. Problem & context

The hosted hub runs in Docker with **no server-side USB**. The HiDock plugs
into the machine running the **browser**, so device access is WebUSB in the
renderer, and synced bytes must be **uploaded** to the server. Today the entire
device path is a Phase-1 stub: all `jensen.*` and `downloadService.*` methods in
`src/lib/electron-api/groups/device.ts` reject with `device path is Phase 1`
(55 stubs). Clicking Download on a `device-only` recording surfaces that error.

What already exists and is reused (not rebuilt):
- `src/services/jensen.ts` — browser WebUSB Jensen client. `downloadFile` is
  **streaming** via an `onChunk` handler (~line 1615). File-list read (the
  ~90 s / 1400-file multi-transfer loop) is solved here.
- `src/services/hidock-device.ts` — higher-level device wrapper.
- Server upload endpoint `POST /api/recordings/upload` (simple multipart) — the
  ingest tail: `saveRecording` → enqueue transcription → WS `recording:new`.
- The transcription queue and WS broadcaster (Phase 0).

What does **not** exist / is a landmine:
- The 4-layer reconciliation lives in `electron/main/services/download-service.ts`,
  which **imports `electron`** and is **not in the server bundle** (kept out by
  the 0f de-leak). It cannot run in the hosted server as-is.
- The Jensen protocol has **no offset/range/seek read** — `downloadFile` streams
  a file from byte 0 only. There is no way to resume a partial device read.

## 2. Scope

**In scope (Phase 1):**
- Un-stub the WebUSB device layer in the SPA facade: Connect gesture, file-list,
  selective download, silent reconnect.
- Streamed upload pipeline: browser streams device bytes to the server with a
  live progress bar and an integrity check (size + SHA-256, both ends).
- Server ingest: reconcile against `device-only` rows (skip already-synced),
  store, enqueue transcription (capped), push WS progress + `recording:new`.

**Explicitly out of scope (deferred):**
- **Resumable / content-range upload.** The device→browser leg cannot resume
  (no seek), so browser→server resume protects only the leg that is already
  reliable, and the current deployment is localhost. A failed transfer retries
  the **whole file**. The server receiver is structured so a resumable variant
  (partfile + offset + `HEAD`) can be added later without reshaping the pipeline.
- Bulk "Sync All" (selective download + select-all covers Phase 1).
- Phase 2 items (sherpa-onnx/diarization, worker_threads rewrite, security
  review, storage policy) and Phase 3 (multi-user).

## 3. Sync model

Selective download: the user picks recordings (or select-all) in the Library;
they queue and stream to the server **one at a time** (the device allows only one
`claimInterface(0)`). Re-syncing reuses the extracted 4-layer reconciliation so
already-synced files are **skipped** (no duplicates). This mirrors the desktop
app's behavior.

## 4. Architecture & data flow

```
┌────────────── Chromium (renderer) — TRACK A ──────────────┐
│ [Connect] gesture → requestDevice → claimInterface(0)     │
│ jensen file-list → user selects → queue (one at a time)   │
│   per file: downloadFile(onChunk)  ── streams from byte 0 │
│     chunk → (a) update SHA-256   (b) push to uploader      │
│ upload client: single streamed POST, declares size;       │
│   sends browser-computed SHA-256 on finalize;             │
│   on failure → retry WHOLE file (device can't seek)        │
└───────────────────────┬───────────────────────────────────┘
                         ▼  POST /api/recordings/sync (stream) → {uploadId,serverSha256}
                         ▼  POST .../sync/:uploadId/finalize {clientSha256}
┌────────────── Fastify — TRACK B ──────────────────────────┐
│ receiver: stream → temp partfile, hash incrementally       │
│ finalize: verify serverSha256==clientSha256 && size==decl. │
│     fail → 4xx + delete partfile                           │
│     ok   → ingest                                          │
│ ingest: reconcile(deviceMeta) vs device-only row           │
│   already synced? → skip. else saveRecording → mark synced │
│   → enqueue transcription (capped) → WS recording:new/progress │
└────────────────────────────────────────────────────────────┘
```

- **Device connect/disconnect events stay browser-local** — they originate from
  WebUSB in the renderer and never reach the server or WS.
- **Upload progress** shown from local uploader state in the active tab; WS is
  used for `recording:new` (other tabs) and transcription progress.
- **Partfiles** are temp files under `/data`, deleted on failed integrity and
  swept by a TTL job for abandoned uploads.

## 5. The two frozen seams (contracts)

Frozen before fan-out so the two tracks cannot drift.

**Seam 1 — DeviceFileSource (Track A produces, upload client consumes):**
```ts
interface DeviceFileSource {
  filename: string
  size: number                     // device-reported byte length
  stream(): AsyncIterable<Uint8Array>  // streams from byte 0; no seek
}
```
No hash field — the hash is computed while streaming, not known up front.

**Seam 2 — Upload wire (Track B implements, Track A calls).**
Two steps, because the client's SHA-256 is only known *after* the body has
finished streaming (an HTTP request header cannot carry it):
```
POST /api/recordings/sync                       (create + stream)
  headers: x-device-file: <base64 JSON metadata: filename,size,deviceId,dateMs,...>
  body:    streamed audio bytes
  → 200 { uploadId, serverSha256, bytesReceived }   // stored as partfile; NOT ingested

POST /api/recordings/sync/:uploadId/finalize
  body: { clientSha256 }
  → server verifies serverSha256 == clientSha256 && bytesReceived == size
     ok       → ingest (reconcile → save → enqueue) → { recordingId, status:'synced'|'skipped' }
     mismatch → 4xx { error } + delete partfile

DELETE /api/recordings/sync/:uploadId             // client abort / cleanup
```
All routes `preHandler: [requireAuth, requireSameOrigin]`. This two-step shape is
also the natural extension point for deferred resume (a `HEAD` on `:uploadId`
returning `bytesReceived` for content-range continuation).

## 6. Workstreams

### Serial setup phase (foundational — done first, with tests)
- **S1 — Freeze seams.** Land the two interfaces above as types; no behavior.
- **S2 — Shared WebUSB mock + conformance test.** A mock that emits real Jensen
  framing (`0x1234` header, 24-bit body length + checksum byte, `0xFFFF`
  file-list markers, multi-packet ~90 s behavior per CLAUDE.md). A
  **protocol-conformance test** feeds the mock's bytes through the **real
  `jensen.ts` parser**, so mock drift fails CI rather than the live device.
- **S3 — Extract reconciliation.** Move the 4-layer reconciliation logic out of
  the Electron-coupled `download-service.ts` into a server-safe
  `electron/main/services/sync-reconcile.ts` with **no `electron` import**, with
  unit tests. This is the highest-risk server piece; it is de-risked before the
  ingest track consumes it.

### Track A — Renderer (parallel)
- Replace the `device.ts` stubs with real WebUSB-backed `jensen` /
  `downloadService` in the SDK facade.
- Connect gesture (`navigator.usb.requestDevice` → `claimInterface(0)`), silent
  reconnect to a previously-authorized device on load.
- Streamed upload client: consume `DeviceFileSource.stream()`, compute SHA-256
  incrementally, POST the stream, show progress, retry the whole file on failure.
- Wire Library "Download" (and select-all) to enqueue one-at-a-time syncs.

### Track B — Server (parallel)
- `POST /api/recordings/sync` streamed receiver: stream → temp partfile →
  incremental SHA-256 → verify size + hash → finalize or 4xx+cleanup.
- Ingest: call `sync-reconcile.ts`; skip already-synced; else `saveRecording`,
  mark `location` synced/both, enqueue transcription **with a cap** (backpressure
  so a large batch doesn't blast the transcription provider), WS `recording:new`
  + progress.
- Partfile TTL sweep for abandoned uploads.

### Serial integrate & verify
Wire the facade, `npm run typecheck`, run the full `vitest` suite, fix. All
against mocks — **no hardware**.

### Human live smoke test (you)
See §8.

## 7. Testing strategy

- **WebUSB is always mocked — never hardware in automated tests** (repo USB
  safety rule). The mock is validated by the S2 conformance test.
- Track A: SDK-group shape tests (mirror the existing `groups/__tests__`
  pattern), upload-client tests (mocked stream + mocked `fetch`), incremental
  hash correctness, whole-file retry.
- Track B: Fastify `inject` route tests for `/api/recordings/sync` (happy path,
  size mismatch, hash mismatch, oversized, unauthenticated), `sync-reconcile`
  unit tests (new / already-synced / partial-match), transcription-cap tests,
  partfile cleanup tests.
- Integration: full suite green + typecheck before the live test.

## 8. Live smoke test & USB safety (first-class risk)

The single live verification, run by the user, is the only hardware contact.

**Procedure:**
1. Chrome/Edge, HTTPS or `localhost`. Click Connect → authorize the HiDock.
2. Select ONE small recording → sync → watch it upload and transcribe.
3. **No retries.** ONE clean `claimInterface(0)`.

**Recovery / stop rule:**
- On `LIBUSB_ERROR_ACCESS`: run the documented **drain** recovery (CLAUDE.md).
- If drain fails: user power-cycles the device.
- **Hard rule:** stop after the first failure, report, and do **not** iterate on
  hardware. Fix against the mock, then attempt one clean connect again.

## 9. Orchestration (multi-subagent)

Contract-first, then parallel fan-out, then serial integrate, then human test:
1. **Serial setup:** S1 (seams) → S2 (mock + conformance) → S3 (reconcile
   extraction). These are foundational; both tracks depend on them.
2. **Parallel fan-out (2 agents):** Track A (renderer) and Track B (server),
   working in disjoint files against frozen seams + the mock.
3. **Serial integrate & verify:** wire facade, typecheck, full test suite, fix.
4. **Human live smoke test** (§8).

Subagents build only against mocks; only one process can claim the device and
parallel/iterative USB access bricks it, so no agent ever touches hardware.

## 10. Error handling

- Device: connect denied / no device / disconnect mid-read → surface a toast,
  abort the current file, leave the queue resumable from the next file (whole-
  file retry for the interrupted one). Never auto-retry a failed `claimInterface`.
- Upload: integrity mismatch → 4xx, delete partfile, mark the item failed with a
  retry affordance. Network drop → whole-file retry (bounded attempts).
- Ingest: reconcile says already-synced → `status: 'skipped'`, no dup. DB/storage
  error → 5xx, partfile cleaned, item marked failed.
- Transcription cap reached → items park in the queue (existing parked-queue
  mechanism), not dropped.

## 11. Acceptance criteria

- In Chrome/Edge, connect the HiDock, select recordings, and see them upload with
  progress and then transcribe server-side.
- Re-syncing skips already-synced files (no duplicates).
- Integrity mismatch is rejected and cleaned up.
- Full automated suite + typecheck green, entirely on mocks.
- One user-driven live smoke test passes with a single clean connect.

## 12. Risks

| # | Risk | Mitigation |
|---|------|------------|
| 1 | Device leg not resumable (no seek) | Whole-file retry; resume deferred |
| 2 | Reconciliation is Electron-coupled | S3 extracts it to server-safe module first |
| 3 | Parallel agents collide on server code | 2-track split in disjoint files; seams frozen |
| 4 | Mock drift → green tests, failed live test | S2 conformance test through real parser |
| 5 | Live connect bricks device | One clean connect, drain recovery, hard stop rule |
| 6 | Transcription fan-out cost blast | Capped enqueue + parked queue backpressure |
| 7 | Orphaned partfiles fill /data | Delete on failure + TTL sweep |
| 8 | Large upload vs proxy/session limits | Streamed transfer; localhost first; revisit for WAN |
