# Hosted Hub Phase 1 — Browser Device Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user connect the HiDock in a Chromium browser, sync selected recordings to the hosted server with a live progress bar and an integrity check, and have them transcribe server-side.

**Architecture:** Renderer streams device bytes over WebUSB and uploads them to a Fastify streaming receiver that writes a partfile, verifies size + SHA-256, then ingests (reconcile → save → enqueue transcription → WS push). Built as a serial setup phase (freeze seams, WebUSB mock, extract reconciliation) then two parallel tracks (renderer, server), then integration, then one human-driven live smoke test. All automated work uses a mocked WebUSB — **never real hardware**.

**Tech Stack:** React 18 + TypeScript + Zustand (renderer); Fastify + better-sqlite3 (server); Vitest; WebUSB (`navigator.usb`); `crypto.subtle` (browser SHA-256) / node `crypto` (server SHA-256).

## Global Constraints

- **USB safety (CLAUDE.md, CRITICAL):** test all USB code with mocks first, never real hardware. Automated tests use the WebUSB mock only. The only hardware contact is the final human smoke test (Task 14).
- **Line length:** 120 chars (TS).
- **Runtime:** server runs under plain Node (container node:22); no `electron` import may enter the server boot path or any server route/service it pulls in.
- **Auth:** every new server route uses `preHandler: [app.requireAuth, app.requireSameOrigin]` (GET may use `requireAuth` only).
- **Env:** server data root is `HIDOCK_DATA_ROOT` (`/data` in container); recordings live under `getRecordingsPath()`.
- **Test commands:** `npx vitest run <path>` (renderer + server share one vitest config). Typecheck: `npm run typecheck`. Lint: `npm run lint`. All commands run from `apps/electron/`.
- **Device streaming is one-way from byte 0** — Jensen has no seek. A failed transfer retries the whole file; no device-leg resume.

---

## File Structure

**Setup**
- `src/lib/electron-api/types-device-sync.ts` (create) — `DeviceFileSource` + wire types (Seam 1 & 2).
- `src/services/__mocks__/webusb-mock.ts` (create) — faithful WebUSB/Jensen device mock.
- `src/services/__tests__/webusb-mock.conformance.test.ts` (create) — round-trips mock bytes through the real parser.
- `electron/main/services/sync-reconcile.ts` (create) — server-safe `isFileAlreadySynced` extraction.
- `electron/main/services/__tests__/sync-reconcile.test.ts` (create).

**Track B — server**
- `electron/server/routes/device-sync.ts` (create) — `POST /api/recordings/sync`, `/finalize`, `DELETE`.
- `electron/server/routes/__tests__/device-sync.test.ts` (create).
- `electron/server/services/partfile-store.ts` (create) — partfile create/append/finalize/delete + TTL sweep.
- `electron/server/services/__tests__/partfile-store.test.ts` (create).
- `electron/server/app.ts` (modify) — register the new route group.

**Track A — renderer**
- `src/lib/electron-api/groups/device.ts` (modify) — replace jensen/downloadService stubs with real WebUSB delegation.
- `src/lib/electron-api/groups/__tests__/device-live.test.ts` (create).
- `src/lib/electron-api/http.ts` (modify) — add `postStream`.
- `src/lib/electron-api/groups/device-sync-client.ts` (create) — streamed uploader (incremental SHA-256, finalize, whole-file retry).
- `src/lib/electron-api/groups/__tests__/device-sync-client.test.ts` (create).
- `src/pages/Device.tsx` (modify) — Connect gesture + silent reconnect wiring.
- `src/pages/Library.tsx` (modify) — route Download → sync queue (one at a time).

**Integration**
- `src/lib/electron-api/index.ts` (modify) — compose the real device group + sync client into the facade.

---

## Task 1: Freeze the seams (types only)

**Files:**
- Create: `src/lib/electron-api/types-device-sync.ts`
- Test: none (type-only; verified by `npm run typecheck` in consuming tasks)

**Interfaces:**
- Produces: `DeviceFileSource`, `DeviceFileMeta`, `SyncCreateResponse`, `SyncFinalizeResponse`.

- [ ] **Step 1: Create the seam types**

```ts
// src/lib/electron-api/types-device-sync.ts
// SEAM 1 — produced by the renderer device layer, consumed by the upload client.
export interface DeviceFileSource {
  filename: string
  size: number // device-reported byte length
  stream(): AsyncIterable<Uint8Array> // streams from byte 0; no seek
}

// Device metadata sent to the server (base64-JSON in the x-device-file header).
export interface DeviceFileMeta {
  filename: string
  size: number
  deviceId?: string
  dateMs?: number
}

// SEAM 2 — server responses.
export interface SyncCreateResponse {
  uploadId: string
  serverSha256: string
  bytesReceived: number
}
export interface SyncFinalizeResponse {
  recordingId: string
  status: 'synced' | 'skipped'
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no consumers yet).

- [ ] **Step 3: Commit**

```bash
git add src/lib/electron-api/types-device-sync.ts
git commit -m "feat(phase1): freeze device-sync seam types"
```

---

## Task 2: WebUSB mock + protocol-conformance test

Builds the mock everything else tests against, and proves it emits real Jensen framing by feeding its bytes through the actual parser in `src/services/jensen.ts`.

**Files:**
- Create: `src/services/__mocks__/webusb-mock.ts`
- Create: `src/services/__tests__/webusb-mock.conformance.test.ts`

**Interfaces:**
- Produces: `makeMockUsbDevice(files: MockFile[]): USBDevice`, `MockFile { filename: string; bytes: Uint8Array }`, `buildJensenListFrames(files)`, `buildJensenFileFrames(bytes)`.

- [ ] **Step 1: Write the failing conformance test**

```ts
// src/services/__tests__/webusb-mock.conformance.test.ts
import { describe, it, expect } from 'vitest'
import { buildJensenListFrames, buildJensenFileFrames } from '../__mocks__/webusb-mock'
import { parseJensenStream } from '../jensen' // export a pure parser (Step 3b)

describe('webusb-mock conformance', () => {
  it('list frames parse back through the real parser', () => {
    const files = [{ filename: 'REC001.hda', bytes: new Uint8Array([1, 2, 3]) }]
    const msgs = parseJensenStream(buildJensenListFrames(files))
    expect(msgs.some(m => m.cmdId === 4)).toBe(true)
  })

  it('file frames reassemble to the original bytes', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256)
    const msgs = parseJensenStream(buildJensenFileFrames(bytes))
    const body = msgs.filter(m => m.cmdId === 5).flatMap(m => [...m.body])
    expect(new Uint8Array(body)).toEqual(bytes)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/services/__tests__/webusb-mock.conformance.test.ts`
Expected: FAIL (`buildJensenListFrames` / `parseJensenStream` not defined).

- [ ] **Step 3a: Build the mock's frame builders**

Use the framing documented in CLAUDE.md (header `0x12 0x34`, 4-byte cmd, 4-byte length whose upper byte is checksum-length and lower 3 bytes are body length: `bodyLen = rawLen & 0x00FFFFFF`). File list is cmd 4 (body starts `0xFF 0xFF` + 4-byte total count + entries); file transfer is cmd 5 with body = a slice of file bytes; final message has `bodyLength = 0`.

```ts
// src/services/__mocks__/webusb-mock.ts
export interface MockFile { filename: string; bytes: Uint8Array }

function frame(cmdId: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length)
  out[0] = 0x12; out[1] = 0x34
  out[2] = (cmdId >> 8) & 0xff; out[3] = cmdId & 0xff
  const len = body.length & 0x00ffffff
  out[8] = (len >> 24) & 0xff; out[9] = (len >> 16) & 0xff
  out[10] = (len >> 8) & 0xff; out[11] = len & 0xff
  out.set(body, 12)
  return out
}

export function buildJensenListFrames(files: MockFile[]): Uint8Array {
  const enc = new TextEncoder()
  const head = new Uint8Array(6)
  head[0] = 0xff; head[1] = 0xff
  new DataView(head.buffer).setUint32(2, files.length)
  const entries = files.flatMap(f => [...enc.encode(f.filename + '\0')])
  const listBody = new Uint8Array([...head, ...entries])
  return new Uint8Array([...frame(4, listBody), ...frame(4, new Uint8Array(0))])
}

export function buildJensenFileFrames(bytes: Uint8Array, chunk = 32768): Uint8Array {
  const frames: number[] = []
  for (let i = 0; i < bytes.length; i += chunk) {
    frames.push(...frame(5, bytes.subarray(i, i + chunk)))
  }
  frames.push(...frame(5, new Uint8Array(0))) // bodyLength=0 terminator
  return new Uint8Array(frames)
}
```

- [ ] **Step 3b: Export a pure parser from `jensen.ts`**

In `src/services/jensen.ts`, add a module-level pure function that reuses the existing packet-parse logic (mirror `parsePacket` at line ~933) so tests and the mock share one parser:

```ts
// src/services/jensen.ts (add near the bottom, module scope)
export interface ParsedJensenMessage { cmdId: number; body: Uint8Array }
export function parseJensenStream(buf: Uint8Array): ParsedJensenMessage[] {
  const out: ParsedJensenMessage[] = []
  let off = 0
  while (off + 12 <= buf.length) {
    if (buf[off] !== 0x12 || buf[off + 1] !== 0x34) { off++; continue }
    const cmdId = (buf[off + 2] << 8) | buf[off + 3]
    const rawLen = (buf[off + 8] << 24) | (buf[off + 9] << 16) | (buf[off + 10] << 8) | buf[off + 11]
    const bodyLen = rawLen & 0x00ffffff
    if (off + 12 + bodyLen > buf.length) break
    out.push({ cmdId, body: buf.subarray(off + 12, off + 12 + bodyLen) })
    off += 12 + bodyLen
  }
  return out
}
```

- [ ] **Step 3c: Add `makeMockUsbDevice`**

```ts
// src/services/__mocks__/webusb-mock.ts (append)
export function makeMockUsbDevice(files: MockFile[]): USBDevice {
  let queue: Uint8Array = new Uint8Array(0)
  const enqueue = (b: Uint8Array) => { queue = new Uint8Array([...queue, ...b]) }
  return {
    opened: false,
    configuration: null,
    async open() { (this as any).opened = true },
    async close() { (this as any).opened = false },
    async selectConfiguration() {},
    async claimInterface() {},
    async releaseInterface() {},
    async transferOut(_ep: number, data: BufferSource) {
      const view = new Uint8Array(data as ArrayBuffer)
      const cmd = (view[2] << 8) | view[3]
      if (cmd === 4) enqueue(buildJensenListFrames(files))
      else if (cmd === 5) enqueue(buildJensenFileFrames(files[0]?.bytes ?? new Uint8Array(0)))
      return { status: 'ok', bytesWritten: view.length } as USBOutTransferResult
    },
    async transferIn(_ep: number, len: number) {
      const slice = queue.subarray(0, len)
      queue = queue.subarray(slice.length)
      return { status: 'ok', data: new DataView(slice.buffer, slice.byteOffset, slice.byteLength) } as USBInTransferResult
    },
  } as unknown as USBDevice
}
```

*(Note: `transferOut` keys off cmd id; extend the cmd→response map if a test needs getFileCount (cmd per `CMD` enum). Keep it minimal — YAGNI.)*

- [ ] **Step 4: Run the conformance test to verify it passes**

Run: `npx vitest run src/services/__tests__/webusb-mock.conformance.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/services/__mocks__/webusb-mock.ts src/services/__tests__/webusb-mock.conformance.test.ts src/services/jensen.ts
git commit -m "feat(phase1): WebUSB mock + Jensen protocol-conformance test"
```

---

## Task 3: Extract reconciliation into a server-safe module

`isFileAlreadySynced` (download-service.ts:~242) only touches DB + fs, but its file imports `electron`. Move the pure logic into a new module with no electron import.

**Files:**
- Create: `electron/main/services/sync-reconcile.ts`
- Create: `electron/main/services/__tests__/sync-reconcile.test.ts`
- Reference: `electron/main/services/download-service.ts:242-291` (source), `file-storage.ts` (`getRecordingsPath`), `database.ts` (`isFileSynced`, `addSyncedFile`, `getRecordingByFilename`).

**Interfaces:**
- Produces: `isFileAlreadySynced(filename: string): { synced: boolean; reason: string }`, `normalizeFilename(filename: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
// electron/main/services/__tests__/sync-reconcile.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as db from '../database'
import { isFileAlreadySynced } from '../sync-reconcile'

vi.mock('../database')
vi.mock('../file-storage', () => ({ getRecordingsPath: () => '/tmp/does-not-exist' }))

describe('isFileAlreadySynced', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns synced when the row is in synced_files', () => {
    vi.mocked(db.isFileSynced).mockReturnValue(true)
    expect(isFileAlreadySynced('REC001.hda')).toEqual({ synced: true, reason: 'In synced_files table' })
  })

  it('returns not-synced when nothing matches', () => {
    vi.mocked(db.isFileSynced).mockReturnValue(false)
    vi.mocked(db.getRecordingByFilename).mockReturnValue(undefined as any)
    expect(isFileAlreadySynced('NEW.hda').synced).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run electron/main/services/__tests__/sync-reconcile.test.ts`
Expected: FAIL (`../sync-reconcile` not found).

- [ ] **Step 3: Create `sync-reconcile.ts` (copy the logic verbatim, no electron import)**

```ts
// electron/main/services/sync-reconcile.ts
import { existsSync } from 'fs'
import { join, basename } from 'path'
import { isFileSynced, addSyncedFile, getRecordingByFilename } from './database'
import { getRecordingsPath } from './file-storage'

export function normalizeFilename(filename: string): string {
  return filename.replace(/\.hda$/i, '.mp3')
}

export function isFileAlreadySynced(filename: string): { synced: boolean; reason: string } {
  if (isFileSynced(filename)) return { synced: true, reason: 'In synced_files table' }

  const wavFilename = filename.replace(/\.hda$/i, '.wav')
  if (wavFilename !== filename && isFileSynced(wavFilename)) {
    return { synced: true, reason: 'WAV version in synced_files' }
  }
  const mp3Filename = normalizeFilename(filename)
  if (mp3Filename !== filename && mp3Filename !== wavFilename && isFileSynced(mp3Filename)) {
    return { synced: true, reason: 'MP3 version in synced_files' }
  }

  const recordingsPath = getRecordingsPath()
  const wavPath = join(recordingsPath, wavFilename)
  if (existsSync(wavPath)) {
    addSyncedFile(filename, wavFilename, wavPath)
    return { synced: true, reason: 'File exists on disk (reconciled)' }
  }
  if (mp3Filename !== filename && mp3Filename !== wavFilename) {
    const mp3Path = join(recordingsPath, mp3Filename)
    if (existsSync(mp3Path)) {
      addSyncedFile(filename, mp3Filename, mp3Path)
      return { synced: true, reason: 'MP3 file exists on disk (reconciled)' }
    }
  }

  const recording = getRecordingByFilename(filename) || getRecordingByFilename(wavFilename)
  if (recording && recording.file_path && existsSync(recording.file_path)) {
    addSyncedFile(filename, basename(recording.file_path), recording.file_path)
    return { synced: true, reason: 'In recordings table with valid file' }
  }

  return { synced: false, reason: 'Not found anywhere' }
}
```

- [ ] **Step 4: Point `download-service.ts` at the extracted module (no behavior change)**

In `electron/main/services/download-service.ts`, delete the `isFileAlreadySynced` method body and `normalizeFilename` static, and re-export/delegate to the new module so existing callers keep working:

```ts
// near the top of download-service.ts, add:
import { isFileAlreadySynced as reconcileIsSynced, normalizeFilename as reconcileNormalize } from './sync-reconcile'
// replace the method with a thin delegate:
isFileAlreadySynced(filename: string) { return reconcileIsSynced(filename) }
// replace static usages of DownloadService.normalizeFilename(x) with reconcileNormalize(x)
```

- [ ] **Step 5: Run reconcile tests + the existing download-service tests**

Run: `npx vitest run electron/main/services/__tests__/sync-reconcile.test.ts electron/main/services/__tests__/baseline-sync.test.ts`
Expected: PASS (extraction is behavior-preserving).

- [ ] **Step 6: Verify no electron import reaches the new module**

Run: `grep -n "from 'electron'" electron/main/services/sync-reconcile.ts || echo CLEAN`
Expected: `CLEAN`.

- [ ] **Step 7: Commit**

```bash
git add electron/main/services/sync-reconcile.ts electron/main/services/__tests__/sync-reconcile.test.ts electron/main/services/download-service.ts
git commit -m "refactor(phase1): extract server-safe sync-reconcile from download-service"
```

---

## Task 4: Partfile store (server)

Owns the temp-file lifecycle + incremental hashing for the streaming receiver.

**Files:**
- Create: `electron/server/services/partfile-store.ts`
- Create: `electron/server/services/__tests__/partfile-store.test.ts`

**Interfaces:**
- Consumes: `HIDOCK_DATA_ROOT`.
- Produces:
  - `createPart(): { uploadId: string; write: (chunk: Uint8Array) => void; finish: () => { sha256: string; bytes: number; path: string } }`
  - `deletePart(uploadId: string): void`
  - `sweepExpiredParts(maxAgeMs: number): number`

- [ ] **Step 1: Write the failing test**

```ts
// electron/server/services/__tests__/partfile-store.test.ts
import { describe, it, expect } from 'vitest'
import { createPart, deletePart } from '../partfile-store'
import { createHash } from 'crypto'

describe('partfile-store', () => {
  it('hashes and sizes streamed chunks', () => {
    const p = createPart()
    const a = new Uint8Array([1, 2, 3]); const b = new Uint8Array([4, 5])
    p.write(a); p.write(b)
    const r = p.finish()
    const expected = createHash('sha256').update(Buffer.concat([Buffer.from(a), Buffer.from(b)])).digest('hex')
    expect(r.sha256).toBe(expected)
    expect(r.bytes).toBe(5)
    deletePart(p.uploadId)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run electron/server/services/__tests__/partfile-store.test.ts`
Expected: FAIL (`../partfile-store` not found).

- [ ] **Step 3: Implement `partfile-store.ts`**

```ts
// electron/server/services/partfile-store.ts
import { createHash, randomUUID } from 'crypto'
import { createWriteStream, mkdirSync, existsSync, rmSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

function partsDir(): string {
  const root = process.env.HIDOCK_DATA_ROOT || '/data'
  const dir = join(root, 'uploads')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function createPart(): {
  uploadId: string
  write: (chunk: Uint8Array) => void
  finish: () => { sha256: string; bytes: number; path: string }
} {
  const uploadId = randomUUID()
  const path = join(partsDir(), `${uploadId}.part`)
  const ws = createWriteStream(path)
  const hash = createHash('sha256')
  let bytes = 0
  return {
    uploadId,
    write(chunk) { hash.update(chunk); bytes += chunk.length; ws.write(Buffer.from(chunk)) },
    finish() { ws.end(); return { sha256: hash.digest('hex'), bytes, path } },
  }
}

export function partPath(uploadId: string): string {
  return join(partsDir(), `${uploadId}.part`)
}

export function deletePart(uploadId: string): void {
  const p = partPath(uploadId)
  if (existsSync(p)) rmSync(p, { force: true })
}

export function sweepExpiredParts(maxAgeMs: number): number {
  const dir = partsDir()
  let removed = 0
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.part')) continue
    const full = join(dir, f)
    if (Date.now() - statSync(full).mtimeMs > maxAgeMs) { rmSync(full, { force: true }); removed++ }
  }
  return removed
}
```

*(`Date.now()` is fine in runtime code; it is only unavailable inside Workflow scripts.)*

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run electron/server/services/__tests__/partfile-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/server/services/partfile-store.ts electron/server/services/__tests__/partfile-store.test.ts
git commit -m "feat(phase1): partfile store with incremental sha256 + TTL sweep"
```

---

## Task 5: Device-sync routes — create + finalize + delete (server)

**Files:**
- Create: `electron/server/routes/device-sync.ts`
- Create: `electron/server/routes/__tests__/device-sync.test.ts`
- Modify: `electron/server/app.ts` (register)
- Reference: `electron/server/routes/recordings.ts:178-260` (ingest fields), `electron/server/routes/__tests__/*` (inject test pattern).

**Interfaces:**
- Consumes: `createPart`, `partPath`, `deletePart` (Task 4); `isFileAlreadySynced` (Task 3); `saveRecording` + `insertRecording` + `getRecordingById` + `addToQueue` (from `database`/`file-storage`); `getBroadcaster()` (`broadcaster`); `SyncCreateResponse`/`SyncFinalizeResponse` (Task 1).
- Produces: `registerDeviceSync(app)`; routes `POST /api/recordings/sync`, `POST /api/recordings/sync/:uploadId/finalize`, `DELETE /api/recordings/sync/:uploadId`.

- [ ] **Step 1: Write the failing test (finalize happy + hash-mismatch)**

```ts
// electron/server/routes/__tests__/device-sync.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import { registerDeviceSync } from '../device-sync'

function appWithAuth() {
  const app = Fastify()
  app.decorate('requireAuth', async () => {})
  app.decorate('requireSameOrigin', async () => {})
  return app
}

describe('device-sync routes', () => {
  beforeEach(() => vi.resetModules())

  it('stream → finalize with matching hash → synced', async () => {
    const app = appWithAuth()
    await registerDeviceSync(app)
    const meta = Buffer.from(JSON.stringify({ filename: 'REC1.hda', size: 3 })).toString('base64')
    const create = await app.inject({
      method: 'POST', url: '/api/recordings/sync',
      headers: { 'x-device-file': meta, 'content-type': 'application/octet-stream' },
      payload: Buffer.from([1, 2, 3]),
    })
    expect(create.statusCode).toBe(200)
    const { uploadId, serverSha256 } = create.json()
    const fin = await app.inject({
      method: 'POST', url: `/api/recordings/sync/${uploadId}/finalize`,
      payload: { clientSha256: serverSha256 },
    })
    expect(fin.statusCode).toBe(200)
    expect(fin.json().status).toMatch(/synced|skipped/)
  })

  it('finalize with wrong hash → 4xx', async () => {
    const app = appWithAuth()
    await registerDeviceSync(app)
    const meta = Buffer.from(JSON.stringify({ filename: 'REC2.hda', size: 3 })).toString('base64')
    const create = await app.inject({
      method: 'POST', url: '/api/recordings/sync',
      headers: { 'x-device-file': meta }, payload: Buffer.from([1, 2, 3]),
    })
    const { uploadId } = create.json()
    const fin = await app.inject({
      method: 'POST', url: `/api/recordings/sync/${uploadId}/finalize`,
      payload: { clientSha256: 'deadbeef' },
    })
    expect(fin.statusCode).toBe(400)
  })
})
```

*(Mock `database`/`file-storage`/`sync-reconcile`/`broadcaster` with `vi.mock` so the test needs no real DB — mirror `recordings.test.ts` mocking.)*

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run electron/server/routes/__tests__/device-sync.test.ts`
Expected: FAIL (`../device-sync` not found).

- [ ] **Step 3: Implement the routes**

```ts
// electron/server/routes/device-sync.ts
import { FastifyInstance } from 'fastify'
import { randomUUID } from 'crypto'
import { basename, extname } from 'path'
import { statSync, existsSync } from 'fs'
import { createPart, partPath, deletePart, sweepExpiredParts } from '../services/partfile-store'
import { isFileAlreadySynced } from '../../main/services/sync-reconcile'
import { saveRecordingFromPath } from '../../main/services/file-storage'
import { insertRecording, getRecordingById, addToQueue } from '../../main/services/database'
import { getBroadcaster } from '../../main/services/broadcaster'
import { BadRequestError, NotFoundError } from './_errors'
import type { DeviceFileMeta } from '../../../src/lib/electron-api/types-device-sync'

// In-memory map of open uploads → their finish() result (bounded; parts are on disk).
const finished = new Map<string, { sha256: string; bytes: number; path: string; meta: DeviceFileMeta }>()

export async function registerDeviceSync(app: FastifyInstance): Promise<void> {
  // Fire a TTL sweep on registration (24h) — abandoned partfiles never accumulate.
  sweepExpiredParts(24 * 60 * 60 * 1000)

  app.post('/api/recordings/sync', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req, reply) => {
    const header = req.headers['x-device-file']
    if (typeof header !== 'string') throw new BadRequestError('missing x-device-file header')
    let meta: DeviceFileMeta
    try { meta = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) } catch { throw new BadRequestError('bad x-device-file') }

    const part = createPart()
    await new Promise<void>((resolve, reject) => {
      req.raw.on('data', (c: Buffer) => part.write(c))
      req.raw.on('end', () => resolve())
      req.raw.on('error', reject)
    })
    const r = part.finish()
    finished.set(part.uploadId, { ...r, meta })
    return reply.code(200).send({ uploadId: part.uploadId, serverSha256: r.sha256, bytesReceived: r.bytes })
  })

  app.post('/api/recordings/sync/:uploadId/finalize', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req, reply) => {
    const { uploadId } = req.params as { uploadId: string }
    const { clientSha256 } = (req.body ?? {}) as { clientSha256?: string }
    const rec = finished.get(uploadId)
    if (!rec) throw new NotFoundError('upload not found')

    if (!clientSha256 || clientSha256 !== rec.sha256 || rec.bytes !== rec.meta.size) {
      deletePart(uploadId); finished.delete(uploadId)
      throw new BadRequestError('integrity check failed')
    }

    // Reconcile: skip if already synced.
    if (isFileAlreadySynced(rec.meta.filename).synced) {
      deletePart(uploadId); finished.delete(uploadId)
      return reply.code(200).send({ recordingId: '', status: 'skipped' })
    }

    // Move partfile into the recordings dir (handles .hda→.wav/.mp3 + collisions).
    const storedPath = saveRecordingFromPath(rec.meta.filename, partPath(uploadId))
    finished.delete(uploadId)
    const fileSize = existsSync(storedPath) ? statSync(storedPath).size : rec.bytes

    const id = randomUUID()
    insertRecording({
      id, filename: basename(storedPath), original_filename: rec.meta.filename,
      file_path: storedPath, file_size: fileSize, duration_seconds: undefined,
      date_recorded: rec.meta.dateMs ? new Date(rec.meta.dateMs).toISOString() : new Date().toISOString(),
      meeting_id: undefined, correlation_confidence: undefined, correlation_method: undefined,
      status: 'ready', location: 'both', transcription_status: 'none',
      on_device: 1, device_last_seen: new Date().toISOString(), on_local: 1,
      source: 'hidock', is_imported: 0,
    })
    addToQueue(id)
    getBroadcaster().broadcast('recording:new', { id })
    import('../../main/services/transcription')
      .then(({ processQueueManually }) => processQueueManually().catch(() => {}))
      .catch(() => {})

    return reply.code(200).send({ recordingId: id, status: 'synced' })
  })

  app.delete('/api/recordings/sync/:uploadId', { preHandler: [app.requireAuth, app.requireSameOrigin] }, async (req, reply) => {
    const { uploadId } = req.params as { uploadId: string }
    deletePart(uploadId); finished.delete(uploadId)
    return reply.code(204).send()
  })
}
```

- [ ] **Step 3b: Add `saveRecordingFromPath` to file-storage if absent**

Check `electron/main/services/file-storage.ts` for a path-based save. If only the buffer-based `saveRecording(name, buffer)` exists, add a sibling that moves an existing file (avoids buffering 440 MB in memory):

```ts
// electron/main/services/file-storage.ts (add)
import { renameSync, copyFileSync, rmSync } from 'fs'
export function saveRecordingFromPath(originalFilename: string, srcPath: string): string {
  const dest = resolveStoredPath(originalFilename) // reuse existing name/collision/.hda logic
  try { renameSync(srcPath, dest) } catch { copyFileSync(srcPath, dest); rmSync(srcPath, { force: true }) }
  return dest
}
```
*(If `resolveStoredPath` isn't already factored out of `saveRecording`, extract it in this step so both share the naming/collision/.hda→.wav logic — do not duplicate it.)*

- [ ] **Step 4: Register in `app.ts`**

In `electron/server/app.ts`, add alongside the other `register*` calls (BEFORE the static handler):

```ts
const { registerDeviceSync } = await import('./routes/device-sync')
await registerDeviceSync(app)
```

- [ ] **Step 5: Run route tests + full server suite**

Run: `npx vitest run electron/server`
Expected: PASS (new device-sync tests + no regressions).

- [ ] **Step 6: Commit**

```bash
git add electron/server/routes/device-sync.ts electron/server/routes/__tests__/device-sync.test.ts electron/server/app.ts electron/main/services/file-storage.ts
git commit -m "feat(phase1): device-sync stream/finalize/delete routes + ingest"
```

---

## Task 6: Lock the transcription backpressure contract (test-only)

**Discovery — no new cap code is needed.** `transcription.ts` already provides
backpressure: `processQueueManually()` returns immediately if the module-level
`isProcessing` mutex is set (`transcription.ts:111`), and the processor drains
the queue **serially** (`isProcessing = true` at :193, `= false` at :325).
Rate-limited items **park** via the existing `parked_until` logic rather than
failing. So a bulk sync cannot spawn concurrent transcription runs or drop
files — every synced file is enqueued with `addToQueue(id)` and the mutex + serial
drain do the rest. This task locks that guarantee with a route-level test and
confirms finalize does not *block* on transcription (fire-and-forget).

**Files:**
- Test: `electron/server/routes/__tests__/device-sync.test.ts` (add case)
- Reference: `electron/main/services/transcription.ts:111,193,325` (mutex + serial drain)

**Interfaces:**
- Consumes: nothing new. `addToQueue` and `processQueueManually` are already
  mocked in the Task 5 test setup.

- [ ] **Step 1: Write the failing test**

Add to `device-sync.test.ts` (reuses the Task 5 `vi.mock` of `database` and
`transcription`; `addToQueue` and `processQueueManually` are `vi.fn()`s there):

```ts
it('enqueues each synced file exactly once and does not block finalize on transcription', async () => {
  const app = appWithAuth(); await registerDeviceSync(app)
  const meta = Buffer.from(JSON.stringify({ filename: 'REC9.hda', size: 3 })).toString('base64')
  const create = await app.inject({
    method: 'POST', url: '/api/recordings/sync',
    headers: { 'x-device-file': meta }, payload: Buffer.from([1, 2, 3]),
  })
  const { uploadId, serverSha256 } = create.json()
  const fin = await app.inject({
    method: 'POST', url: `/api/recordings/sync/${uploadId}/finalize`,
    payload: { clientSha256: serverSha256 },
  })
  expect(fin.statusCode).toBe(200)
  expect(fin.json().status).toBe('synced')
  // Every synced file is enqueued; the finalize response does NOT await transcription.
  const { addToQueue } = await import('../../../main/services/database')
  expect(vi.mocked(addToQueue)).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run electron/server/routes/__tests__/device-sync.test.ts -t "enqueues each synced file"`
Expected: FAIL if the Task 5 mock does not yet expose `addToQueue` as a spy — add
`addToQueue: vi.fn()` to the `database` mock. If Task 5 already awaited
`processQueueManually`, the test still passes on status but this locks the
fire-and-forget contract.

- [ ] **Step 3: Confirm the production contract (no new code)**

Verify the Task 5 finalize handler calls `addToQueue(id)` then a **fire-and-forget**
`processQueueManually()` (the `import(...).then(...)` form — NOT awaited). If it
was awaited, change it to fire-and-forget so a slow/parked queue never blocks the
sync HTTP response. No cap code is added — the `isProcessing` mutex is the cap.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run electron/server/routes/__tests__/device-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/server/routes/__tests__/device-sync.test.ts electron/server/routes/device-sync.ts
git commit -m "test(phase1): lock transcription backpressure contract for bulk sync"
```

---

## Task 7: Add `postStream` to the SDK HTTP transport (renderer)

`http.ts` has no streaming-body method; the uploader needs one.

**Files:**
- Modify: `src/lib/electron-api/http.ts`
- Test: `src/lib/electron-api/__tests__/http.test.ts` (add case)

**Interfaces:**
- Produces: `postStream(path: string, body: BodyInit, headers?: Record<string,string>): Promise<HttpResult>`.

- [ ] **Step 1: Write the failing test**

```ts
// add to src/lib/electron-api/__tests__/http.test.ts
it('postStream sends body with credentials and returns parsed result', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ uploadId: 'u1' }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const { postStream } = await import('../http')
  const r = await postStream('/api/recordings/sync', new Uint8Array([1, 2, 3]), { 'x-device-file': 'abc' })
  expect(r.ok).toBe(true)
  expect((r.data as any).uploadId).toBe('u1')
  expect(fetchMock.mock.calls[0][1].credentials).toBe('include')
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/lib/electron-api/__tests__/http.test.ts -t postStream`
Expected: FAIL (`postStream` not exported).

- [ ] **Step 3: Implement `postStream`** (mirror `post`/`postForm` error+401 handling)

```ts
// src/lib/electron-api/http.ts
export async function postStream(path: string, body: BodyInit, headers: Record<string, string> = {}): Promise<HttpResult> {
  try {
    const init: RequestInit & { duplex?: 'half' } = {
      method: 'POST', credentials: 'include', body, headers,
    }
    if (body instanceof ReadableStream) init.duplex = 'half'
    const response = await fetch(path, init as RequestInit)
    if (response.status === 401) { onUnauthorized?.(); return { ok: false, status: 401, error: 'unauthenticated' } }
    const data = await response.json().catch(() => undefined)
    return { ok: response.ok, status: response.status, data, error: response.ok ? undefined : (data as any)?.error }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'network error' }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/electron-api/__tests__/http.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/electron-api/http.ts src/lib/electron-api/__tests__/http.test.ts
git commit -m "feat(phase1): add postStream to REST SDK transport"
```

---

## Task 8: Streamed upload client (renderer)

Consumes a `DeviceFileSource`, hashes while streaming, POSTs, finalizes, retries whole-file on failure.

**Files:**
- Create: `src/lib/electron-api/groups/device-sync-client.ts`
- Create: `src/lib/electron-api/groups/__tests__/device-sync-client.test.ts`

**Interfaces:**
- Consumes: `postStream`, `post` (Task 7 / existing); `DeviceFileSource`, `SyncCreateResponse`, `SyncFinalizeResponse` (Task 1).
- Produces: `makeDeviceSyncClient({ http }): { syncFile(src: DeviceFileSource, onProgress?: (sent: number) => void): Promise<SyncFinalizeResponse> }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/electron-api/groups/__tests__/device-sync-client.test.ts
import { describe, it, expect, vi } from 'vitest'
import { makeDeviceSyncClient } from '../device-sync-client'

function srcOf(bytes: number[]) {
  return { filename: 'REC1.hda', size: bytes.length, async *stream() { yield new Uint8Array(bytes) } }
}

it('streams, sends browser hash on finalize, returns synced', async () => {
  const http = {
    postStream: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { uploadId: 'u1', serverSha256: 'x', bytesReceived: 3 } }),
    post: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { recordingId: 'r1', status: 'synced' } }),
  } as any
  const client = makeDeviceSyncClient({ http })
  const res = await client.syncFile(srcOf([1, 2, 3]))
  expect(res.status).toBe('synced')
  expect(http.post.mock.calls[0][0]).toBe('/api/recordings/sync/u1/finalize')
  expect(http.post.mock.calls[0][1]).toHaveProperty('clientSha256')
})

it('retries the whole file once on a failed create', async () => {
  const postStream = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 0, error: 'network' })
    .mockResolvedValueOnce({ ok: true, status: 200, data: { uploadId: 'u2', serverSha256: 'x', bytesReceived: 3 } })
  const http = { postStream, post: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { recordingId: 'r', status: 'synced' } }) } as any
  const client = makeDeviceSyncClient({ http })
  const res = await client.syncFile(srcOf([1, 2, 3]))
  expect(res.status).toBe('synced')
  expect(postStream).toHaveBeenCalledTimes(2)
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/lib/electron-api/groups/__tests__/device-sync-client.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the client**

```ts
// src/lib/electron-api/groups/device-sync-client.ts
import type { DeviceFileSource, DeviceFileMeta, SyncCreateResponse, SyncFinalizeResponse } from '../types-device-sync'

interface Deps { http: { postStream: (p: string, b: BodyInit, h?: Record<string, string>) => Promise<{ ok: boolean; status: number; data?: unknown; error?: string }>; post: (p: string, b?: unknown) => Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> } }

const MAX_ATTEMPTS = 2

async function collectAndHash(src: DeviceFileSource, onProgress?: (sent: number) => void): Promise<{ blob: Blob; hashHex: string }> {
  const chunks: Uint8Array[] = []
  let sent = 0
  for await (const chunk of src.stream()) { chunks.push(chunk); sent += chunk.length; onProgress?.(sent) }
  const blob = new Blob(chunks as BlobPart[])
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  const hashHex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  return { blob, hashHex }
}

export function makeDeviceSyncClient({ http }: Deps) {
  return {
    async syncFile(src: DeviceFileSource, onProgress?: (sent: number) => void): Promise<SyncFinalizeResponse> {
      const meta: DeviceFileMeta = { filename: src.filename, size: src.size }
      const header = btoa(JSON.stringify(meta))
      let lastErr = 'sync failed'
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // Device can't seek → re-read the whole file each attempt.
        const { blob, hashHex } = await collectAndHash(src, onProgress)
        const created = await http.postStream('/api/recordings/sync', blob, { 'x-device-file': header })
        if (!created.ok) { lastErr = created.error ?? `HTTP ${created.status}`; continue }
        const { uploadId, serverSha256 } = created.data as SyncCreateResponse
        if (serverSha256 !== hashHex) { lastErr = 'integrity mismatch'; continue }
        const fin = await http.post(`/api/recordings/sync/${uploadId}/finalize`, { clientSha256: hashHex })
        if (!fin.ok) { lastErr = fin.error ?? `HTTP ${fin.status}`; continue }
        return fin.data as SyncFinalizeResponse
      }
      throw new Error(lastErr)
    },
  }
}
export type DeviceSyncClient = ReturnType<typeof makeDeviceSyncClient>
```

*(NOTE: this MVP buffers the file to a Blob to hash before upload. True streaming-while-hashing is possible with a `ReadableStream` + running digest, but browsers can't `crypto.subtle.digest` incrementally without a userland SHA-256. Buffering is acceptable for Phase 1 localhost; flag streaming-hash as a Phase-1.5 follow-up in the plan's Notes. This is the one deliberate simplification vs. the spec's "hash while streaming".)*

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/electron-api/groups/__tests__/device-sync-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/electron-api/groups/device-sync-client.ts src/lib/electron-api/groups/__tests__/device-sync-client.test.ts
git commit -m "feat(phase1): streamed device-sync upload client with whole-file retry"
```

---

## Task 9: Un-stub the device SDK group (renderer)

Replace the 55 Phase-1 stubs in `device.ts` with real delegation to a `JensenDevice` instance, exposing a `DeviceFileSource` per file.

**Files:**
- Modify: `src/lib/electron-api/groups/device.ts`
- Create: `src/lib/electron-api/groups/__tests__/device-live.test.ts`
- Reference: `src/services/jensen.ts` (`JensenDevice`: `connect(signal?)`, `tryConnect(preAuthorized?)`, `disconnect()`, `getFileCount(timeout?)`, `listFiles(onProgress?, expected?, onNew?)`, `downloadFile(filename, size, onChunk, onProgress?, signal?)`).

**Interfaces:**
- Consumes: `JensenDevice`, the WebUSB mock (Task 2), `DeviceFileSource` (Task 1).
- Produces: real `jensen.*` methods + a `downloadService.deviceFileSource(filename, size): DeviceFileSource`.

- [ ] **Step 1: Write the failing test (mock-backed)**

```ts
// src/lib/electron-api/groups/__tests__/device-live.test.ts
import { describe, it, expect, vi } from 'vitest'
import { makeDeviceGroup } from '../device'
import { makeMockUsbDevice } from '../../../../services/__mocks__/webusb-mock'

it('lists files from a mocked device', async () => {
  const mockDev = makeMockUsbDevice([{ filename: 'REC001.hda', bytes: new Uint8Array([1, 2, 3]) }])
  vi.stubGlobal('navigator', { usb: { requestDevice: vi.fn().mockResolvedValue(mockDev), getDevices: vi.fn().mockResolvedValue([]) } })
  const grp = makeDeviceGroup()
  await grp.jensen.connect()
  const files = await grp.jensen.listFiles()
  expect(files?.[0]?.name).toBe('REC001.hda')
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/lib/electron-api/groups/__tests__/device-live.test.ts`
Expected: FAIL (still stubbed → rejects `device path is Phase 1`).

- [ ] **Step 3: Rewrite `device.ts` to delegate to a shared `JensenDevice`**

```ts
// src/lib/electron-api/groups/device.ts  (replace stub bodies)
import { JensenDevice } from '../../../services/jensen'
import type { DeviceFileSource } from '../types-device-sync'

export function makeDeviceGroup() {
  const dev = new JensenDevice()
  return {
    jensen: {
      connect: (signal?: AbortSignal) => dev.connect(signal),
      tryConnect: (pre?: USBDevice) => dev.tryConnect(pre),
      disconnect: () => dev.disconnect(),
      getFileCount: (timeout?: number) => dev.getFileCount(timeout),
      listFiles: (onProgress?: (a: number, b: number) => void, expected?: number, onNew?: (f: unknown[]) => void) =>
        dev.listFiles(onProgress, expected, onNew as never),
      // ...delegate the remaining real jensen methods that exist on JensenDevice
      // (deleteFile, formatCard, getSettings, etc.). For any jensen method with
      // NO JensenDevice counterpart, keep the phase1Reject stub — do not invent.
    },
    downloadService: {
      // Expose a DeviceFileSource for the upload client (Seam 1).
      deviceFileSource(filename: string, size: number): DeviceFileSource {
        return {
          filename, size,
          async *stream() {
            const queue: Uint8Array[] = []
            let done = false
            const p = dev.downloadFile(filename, size, (chunk) => queue.push(chunk), undefined)
            // drain the queue as chunks arrive
            p.then(() => { done = true })
            while (!done || queue.length) {
              if (queue.length) yield queue.shift() as Uint8Array
              else await new Promise(r => setTimeout(r, 5))
            }
          },
        }
      },
      // ...keep phase1Reject stubs for downloadService methods that have no web path yet.
    },
  }
}
```

*(Enumerate the real delegations against `JensenDevice`'s actual public methods; leave genuine no-counterpart methods as `phase1Reject`. Do not fabricate device methods.)*

- [ ] **Step 4: Run to verify pass + full SDK suite**

Run: `npx vitest run src/lib/electron-api/groups/__tests__/device-live.test.ts src/lib/electron-api/__tests__/device.test.ts`
Expected: device-live PASS; adjust the old stub-shape test (`device.test.ts`) to assert only the still-stubbed methods reject.

- [ ] **Step 5: Commit**

```bash
git add src/lib/electron-api/groups/device.ts src/lib/electron-api/groups/__tests__/device-live.test.ts src/lib/electron-api/__tests__/device.test.ts
git commit -m "feat(phase1): un-stub device SDK group over real WebUSB Jensen"
```

---

## Task 10: Connect gesture + silent reconnect (renderer UI)

**Files:**
- Modify: `src/pages/Device.tsx` (the existing "Connect Device" button, ~line 948)
- Test: `src/pages/__tests__/Device.connect.test.tsx` (create)

**Interfaces:**
- Consumes: `window.electronAPI.jensen.connect/tryConnect` (Task 9).

- [ ] **Step 1: Write the failing test**

```tsx
// src/pages/__tests__/Device.connect.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import Device from '../Device'

it('Connect Device calls jensen.connect', async () => {
  const connect = vi.fn().mockResolvedValue(true)
  ;(window as any).electronAPI = { jensen: { connect, tryConnect: vi.fn().mockResolvedValue(false) } }
  render(<Device />)
  fireEvent.click(screen.getByText(/Connect Device/i))
  await waitFor(() => expect(connect).toHaveBeenCalled())
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/pages/__tests__/Device.connect.test.tsx`
Expected: FAIL (button not wired to `connect`).

- [ ] **Step 3: Wire the button + silent reconnect**

In `Device.tsx`: the Connect button's handler calls `await window.electronAPI.jensen.connect()`. Add a mount effect that attempts silent reconnect to an already-authorized device:

```tsx
useEffect(() => {
  // Silent reconnect — no user gesture needed for a previously-authorized device.
  window.electronAPI.jensen.tryConnect?.().catch(() => {})
}, [])
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/pages/__tests__/Device.connect.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Device.tsx src/pages/__tests__/Device.connect.test.tsx
git commit -m "feat(phase1): wire Connect gesture + silent reconnect"
```

---

## Task 11: Route device download through the sync client (renderer)

Library already delegates its Download button to `useOperations().queueDownload`
(`Library.tsx:527`). In hosted mode `queueDownload` calls the **stubbed**
`downloadService.queueDownloads` → rejects. The fix is in `useOperations.ts`:
drive the sync client instead. Library.tsx is unchanged.

**Files:**
- Modify: `src/hooks/useOperations.ts` (`queueDownload`, ~line 156; `queueBulkDownloads`, ~line 178)
- Modify: `src/lib/electron-api/types.ts` (add `deviceSync` + `downloadService.deviceFileSource` to the `ElectronAPI` interface so `window.electronAPI.deviceSync` typechecks)
- Create: `src/hooks/__tests__/useOperations.sync.test.ts`
- Reference: `src/hooks/__tests__/useOperations.test.ts` (mock pattern), `src/types/unified-recording.ts` (`isDeviceOnly`, `UnifiedRecording` fields: `deviceFilename`, `size`, `filename`, `dateRecorded`).

**Interfaces:**
- Consumes: `window.electronAPI.downloadService.deviceFileSource(filename, size)` (Task 9), `window.electronAPI.deviceSync.syncFile(src)` (Task 12 facade), `SyncFinalizeResponse` (Task 1).

- [ ] **Step 1: Write the failing test (complete)**

```ts
// src/hooks/__tests__/useOperations.sync.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))
vi.mock('@/hooks/useDownloadOrchestrator', () => ({
  cancelDownloads: vi.fn(), cancelDownloadsComplete: vi.fn(), processPendingDownloads: vi.fn(),
}))
vi.mock('@/store/features/useTranscriptionStore', () => ({
  useTranscriptionStore: vi.fn((sel: any) => {
    const state = { addToQueue: vi.fn(), remove: vi.fn(), clear: vi.fn(), queue: new Map() }
    return typeof sel === 'function' ? sel(state) : state
  }),
}))
import { useOperations } from '../useOperations'

const syncFile = vi.fn().mockResolvedValue({ recordingId: 'r1', status: 'synced' })
const deviceFileSource = vi.fn().mockReturnValue({ filename: 'REC1.hda', size: 3, async *stream() {} })

describe('useOperations.queueDownload (device sync)', () => {
  beforeEach(() => {
    syncFile.mockClear(); deviceFileSource.mockClear()
    ;(window as any).electronAPI = { downloadService: { deviceFileSource }, deviceSync: { syncFile } }
  })

  it('syncs a device-only recording via deviceSync.syncFile', async () => {
    const { result } = renderHook(() => useOperations())
    const rec: any = {
      id: 'x', filename: 'REC1.hda', deviceFilename: 'REC1.hda', size: 3,
      location: 'device-only', dateRecorded: new Date(),
    }
    let ok: boolean | undefined
    await act(async () => { ok = await result.current.queueDownload(rec) })
    expect(ok).toBe(true)
    expect(deviceFileSource).toHaveBeenCalledWith('REC1.hda', 3)
    expect(syncFile).toHaveBeenCalledTimes(1)
  })

  it('returns false for a non-device-only recording', async () => {
    const { result } = renderHook(() => useOperations())
    const rec: any = { id: 'y', filename: 'L.wav', location: 'local-only', dateRecorded: new Date() }
    let ok: boolean | undefined
    await act(async () => { ok = await result.current.queueDownload(rec) })
    expect(ok).toBe(false)
    expect(syncFile).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/hooks/__tests__/useOperations.sync.test.ts`
Expected: FAIL — `queueDownload` still calls `downloadService.queueDownloads`, so `deviceFileSource`/`syncFile` are never called.

- [ ] **Step 3: Rewrite `queueDownload` + `queueBulkDownloads`**

Replace the two callbacks in `src/hooks/useOperations.ts`:

```ts
const queueDownload = useCallback(async (recording: UnifiedRecording) => {
  if (!isDeviceOnly(recording)) return false
  try {
    const src = window.electronAPI.downloadService.deviceFileSource(recording.deviceFilename, recording.size)
    const res = await window.electronAPI.deviceSync.syncFile(src)
    toast({ title: res.status === 'skipped' ? 'Already synced' : 'Synced', description: recording.filename })
    return true
  } catch (e) {
    toast({ title: 'Sync failed', description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' })
    return false
  }
}, [])

const queueBulkDownloads = useCallback(async (recordings: UnifiedRecording[]) => {
  const eligible = recordings.filter(isDeviceOnly)
  let done = 0
  for (const r of eligible) { if (await queueDownload(r)) done++ } // serial — one device claim at a time
  if (done) toast({ title: `${done} recording${done > 1 ? 's' : ''} synced` })
  return done
}, [queueDownload])
```

Then add the facade types in `src/lib/electron-api/types.ts` so the calls typecheck:

```ts
// in the ElectronAPI interface:
//   deviceSync: { syncFile(src: DeviceFileSource, onProgress?: (sent: number) => void): Promise<SyncFinalizeResponse> }
// and on downloadService:
//   deviceFileSource(filename: string, size: number): DeviceFileSource
// (import DeviceFileSource + SyncFinalizeResponse from './types-device-sync')
```

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `npx vitest run src/hooks/__tests__/useOperations.sync.test.ts && npm run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useOperations.ts src/lib/electron-api/types.ts src/hooks/__tests__/useOperations.sync.test.ts
git commit -m "feat(phase1): route device download through the sync client"
```

---

## Task 12: Compose the facade + full verification

**Files:**
- Modify: `src/lib/electron-api/index.ts`

**Interfaces:**
- Consumes: `makeDeviceGroup` (Task 9), `makeDeviceSyncClient` (Task 8).

- [ ] **Step 1: Wire the real device group + sync client into the facade**

In `src/lib/electron-api/index.ts`, replace the stub composition so `api.jensen` / `api.downloadService` come from the real `makeDeviceGroup()` (preserving `downloadService.onStateUpdate` from the events group), and attach the sync client:

```ts
const deviceGroup = makeDeviceGroup()
Object.assign(api, { jensen: deviceGroup.jensen })
Object.assign(api.downloadService, deviceGroup.downloadService)
Object.assign(api, { deviceSync: makeDeviceSyncClient({ http: httpTransport }) })
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Full test suite**

Run: `npx vitest run`
Expected: PASS (all suites).

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/electron-api/index.ts
git commit -m "feat(phase1): compose real device group + sync client into facade"
```

---

## Task 13: Rebuild the container image

**Files:** none (build only).

- [ ] **Step 1: Build & redeploy**

Run: `docker compose up --build -d`
Expected: build EXIT 0; `docker compose ps` shows `healthy`.

- [ ] **Step 2: Confirm the SPA bundle changed and API is up**

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8788/healthz`
Expected: `200`.

- [ ] **Step 3: Commit** (nothing to commit; note the deploy in the task log)

---

## Task 14: Live smoke test (HUMAN — the only hardware contact)

**Not automatable. Run by the user. Obeys the USB safety stop rule.**

- [ ] **Step 1:** Open `http://localhost:8788` in Chrome/Edge; log in.
- [ ] **Step 2:** Go to Device → click **Connect Device** → authorize the HiDock in the WebUSB picker. **One clean connect.**
- [ ] **Step 3:** In Library, select **one small** device-only recording → Download. Watch the progress bar, then confirm it appears as synced and enters transcription.
- [ ] **Step 4 (recovery, only if it fails):** On `LIBUSB_ERROR_ACCESS`, run the documented **drain** (CLAUDE.md); if drain fails, power-cycle the device. **STOP after the first failure — do not retry on hardware.** Fix against the mock, rebuild, then attempt one clean connect again.
- [ ] **Step 5:** Acceptance met when one file syncs, verifies, and transcribes end-to-end, and re-syncing it reports "skipped".

---

## Notes / deliberate simplifications (Phase-1.5 follow-ups)

- **Hash-while-streaming:** Task 8 buffers each file to a Blob to compute SHA-256 (browsers lack incremental `crypto.subtle`). For 440 MB files this holds the file in memory; acceptable on localhost. Follow-up: userland streaming SHA-256 to hash without full buffering.
- **Resumable upload:** deferred by design (device leg can't seek). The two-step route shape supports adding `HEAD :uploadId` + content-range later without reshaping.
- **Bulk "Sync All":** out of scope; selective + select-all covers Phase 1.

## Orchestration (subagent mapping)

- **Serial setup:** Tasks 1 → 2 → 3 (all fan-out depends on these).
- **Parallel fan-out — Track B (server):** Tasks 4 → 5 → 6. **Track A (renderer):** Tasks 7 → 8, and 9 → 10 → 11. Track A and Track B touch disjoint files.
- **Serial integrate:** Task 12 (needs 8, 9). **Deploy:** Task 13. **Human:** Task 14.
