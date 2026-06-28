# Hosted Hub — Plan 0e: Renderer → REST/WS Client SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Run **everything** from `apps/electron/`. Branch `feat/hosted-knowledge-hub`. Line length 120; TS strict; Vitest.

**Goal:** Reimplement the renderer's `window.electronAPI` facade — today a single `callIPC` chokepoint plus ~40 method groups in `electron/preload/index.ts` — as a typed **client SDK** that calls the 0c REST endpoints over `fetch` and subscribes to the 0c-1 `/ws` broadcaster for the `on*`/`onProgress`/`onStateUpdate` events. Strip the renderer's Electron-isms (`hidock-media://` → 0d media URL; window chrome/titlebar; native dialogs; `shell.openExternal`; native open/reveal). The browser WebUSB device path (`jensen:*`, `downloadService:*`, the recording watcher) is **Phase 1 — explicitly out of scope here** and its facade groups are left untouched in this plan.

**Architecture (the one big idea):** Build a new browser-only module `src/lib/electron-api/` that constructs the **same `ElectronAPI` object shape** the renderer already imports as `window.electronAPI`, but backed by `fetch`/`WebSocket` instead of `ipcRenderer.invoke`. The renderer keeps calling `window.electronAPI.<group>.<method>(...)` exactly as today; we swap what `window.electronAPI` *is* at app bootstrap. The 0c REST layer returns **plain data on `2xx`** and `{ error, details? }` on `4xx/5xx` — but the ~150 call sites each destructure a **specific** shape (`Result<T>`, raw array, `string | false`, `boolean`, inline `{success,data,error}`). **The central, dominant risk of 0e is the per-method re-wrap: each SDK method must return EXACTLY what its call sites expect.** A wrong wrap typechecks fine and fails silently at runtime. This plan front-loads a contract inventory, then implements group-by-group with a shape-assertion test per method, and defers live browser validation to the operator.

**Tech Stack:** React 18 + TS, Vitest + `happy-dom`/`jsdom`, `fetch` (mocked via `vi.stubGlobal`/`msw`-free hand mocks), native `WebSocket` (mocked). The REST server (0b/0c) and `/ws` (0c-1) are the runtime backends; this plan does **not** stand up a server — it mocks the wire and leaves real-server validation to the deferred browser pass.

---

## ⚠️ Pre-execution corrections (controller, 2026-06-27) — these OVERRIDE the text below
1. **Branch:** the REST API + media are MERGED to `main` (@2e79284b). Execute on `feat/hosted-hub-0e-renderer` (off main) — NOT `feat/hosted-knowledge-hub`.
2. **No custom same-origin write header.** Verified: `requireSameOrigin` (`auth.ts:37`) checks the **`Origin` header vs `PUBLIC_URL`** and allows a missing Origin. Browsers send `Origin` automatically on same-origin writes, so it passes with no action. `http.ts` needs **`credentials: 'include'` only** — do NOT invent/set an `X-Requested-With` header; the http test asserts `credentials:'include'` on writes, not a custom header. (Supersedes Task 1 Step 1/3 + Risk 5.)
3. **0d media URL is recording-ID-based.** Verified: the route is **`GET /api/recordings/:id/media`** (`media.ts:46`; resolves `file_path` server-side). `getMediaUrl` must return `${origin}/api/recordings/${recordingId}/media` keyed on the **recording id** — NOT a `?p=<filePath>` form. Adapt call sites to pass the recording id (available on the recording row alongside the path). (Supersedes Task 10 Step 1 + the media bullet.)
4. **Device groups (Risk 7) = no-op stubs** satisfying `ElectronAPI`, rejecting/returning safe defaults with a `'device path is Phase 1'` marker; `on*` return a no-op unsubscribe. Phase-1 WebUSB lands later. (Resolves Risk 7 / Task 9 → option a.)

## Global Constraints & Decisions

- **`window.electronAPI` is replaced, not patched.** A new `installRestApi()` (in `src/lib/electron-api/index.ts`) builds the full `ElectronAPI` object and assigns it to `window.electronAPI` (and exports it for direct import). The `ElectronAPI` interface itself (the contract the renderer's 41 files compile against) is **lifted unchanged** from `electron/preload/index.ts` into `src/lib/electron-api/types.ts` so the renderer's existing type-checking is the first guardrail. **Every method signature stays byte-identical**; only the implementation body changes from `callIPC(channel, …)` to `http.<verb>(url, body)`.

- **Per-method shape contracts are the deliverable, not a uniform rule.** There is **no single re-wrap function**. The REST endpoint returns plain data; each SDK method adapts that to its call sites' shape:
  - **`Result<T>` methods** (e.g. `contacts.getAll`, `projects.*`, `rag.*`, `outputs.*`, `speakers.*`, `voiceprints.*`, `summarizationTemplates.*`): on `2xx` return `{ success: true, data }`; on `4xx/5xx` return `{ success: false, error }` (do **not** throw — call sites do `if (result.success)`, see `useContactsStore.ts:55`, `Projects.tsx:87`).
  - **Raw-data methods** (e.g. `recordings.getAll(): any[]`, `meetings.getAll(): any[]`, `transcripts.getByRecordingId(): any`): on `2xx` return the body directly; on error **throw** (call sites `await` and treat as a plain value, e.g. `useUnifiedRecordings.ts:420`). **Pagination caveat:** `GET /api/recordings` returns `{items,total}` (0c §1), but `recordings.getAll()` call sites expect a bare `any[]` — the SDK method must unwrap `.items` (and a follow-up task wires paging where a call site needs `total`).
  - **`string | false` methods** (`recordings.transcribe`, `recordings.addToQueue`): on `2xx` return the queue-item id string; on error return `false` (call site `useOperations.ts:66` does `const id = await …; if (id) addToQueue(id, …)`).
  - **`boolean` methods** (`recordings.delete`, `chat.clearHistory`, `migration` booleans): map `2xx`→`true`, error→`false` or throw per the exact call site.
  - **inline `{success,data?,error?}` methods** (e.g. `recordings.getCandidates`, `recordings.addExternalByPath`, `actionables.updateStatus`, `knowledge.update`): build that exact inline object from the HTTP result.
  - The **inventory task (Task 2)** records the expected shape for every method before any implementation, and each group task asserts it.

- **One thin transport, many adapters.** A single `http` helper (`src/lib/electron-api/http.ts`) does `fetch` with: base URL, `credentials: 'include'` (session cookie from 0b), `X-Requested-With`/same-origin header for writes (0c `requireSameOrigin`), JSON encode/decode, and a normalized outcome `{ ok: boolean; status: number; data?: unknown; error?: string }`. Adapters (above) consume this; the helper itself never decides call-site shape.

- **Events move from `ipcRenderer.on(channel, …)` to a `/ws` subscription multiplexer.** A `WsClient` (`src/lib/electron-api/ws.ts`) opens one authenticated `WebSocket` to `/ws`, parses each `{channel, payload}` frame (0c-1 wire format), and dispatches to per-channel listener sets. Every `on*`/`onProgress`/`onStateUpdate` facade method becomes `wsClient.subscribe(channel, callback)` returning the same `() => void` unsubscribe. **Channel strings are preserved verbatim** (`transcription:progress`, `domain-event`, `voiceprint:captured`, `recording:new`, `download-service:state-update`, `activity-log:entry`, `migration:progress`, `integrity:progress`) so callbacks and payload shapes are unchanged. The WS auto-reconnects with backoff; on reconnect, existing subscriptions are re-attached transparently (listeners are held in the multiplexer, not on the socket).

- **Media: `hidock-media://` → 0d HTTP media URL.** `getMediaUrl(filePath)` in `src/utils/audioUtils.ts` is rewritten to return the 0d media endpoint URL (range-capable HTTP) instead of `hidock-media://media/?p=…`. This is a 1-line behavioral swap with broad reach (the `<audio>` `src`), so it gets its own task + test and is called out for the deferred browser pass.

- **Electron-isms removed from the renderer (each its own small task):**
  - **Window chrome / titlebar** — `Layout.tsx` `titlebar-drag-region`/`titlebar-no-drag` classes and any window-control buttons are removed (browser tab has its own chrome). `-webkit-app-region` CSS dropped.
  - **Native file dialogs** — `recordings.addExternal()` (opened an OS file picker) → replaced by a browser `<input type="file">` upload flow hitting `POST /api/recordings/upload` (0c-2). `outputs.saveToFile` / `transcripts.export` → browser download (anchor + `Blob`/`Content-Disposition`), no native save dialog.
  - **Clipboard** — `outputs.copyToClipboard` (a main-process call) → `navigator.clipboard.writeText` in the renderer (0c dropped the REST route).
  - **Native open/reveal** — `storage.openFolder` / `storage.openFile` / `storage.revealInFolder` (`SourceReader.tsx`, `Library.tsx`, `Settings.tsx`) → **removed/disabled** (no server desktop; 0c dropped these). Replace with a no-op + hidden UI affordance, or a download link where a file is the target.
  - **`shell.openExternal`** — any external-link open becomes a plain `window.open(url, '_blank')`.

- **Device picker stays as browser WebUSB.** `jensen:*`, `downloadService:*`, and the recording-watcher facade groups (`onRecordingAdded`, `onStateUpdate`) are **Phase 1**, not re-pointed at REST in this plan. The SDK must still expose these groups so the renderer typechecks; in 0e they remain wired to whatever the Phase-1 WebUSB bridge provides (out of scope) **or** stubbed to safe no-ops/`Promise.reject('device path is Phase 1')` if Phase 1 is not yet present. **Decision flagged (Risk 7):** confirm whether 0e ships device groups as no-op stubs or whether Phase-1 WebUSB lands first.

- **What this plan does NOT do:** it does not build/modify any server route (0b/0c/0c-1/0d own those), does not run a real server, does not do live browser validation, and does not touch the Phase-1 WebUSB implementation. It produces the renderer SDK + Electron-ism removals + a green Vitest suite proving every method's shape contract against a mocked wire.

---

## Risks (read before executing)

1. **★ The ~150 per-method shape contracts are the whole ballgame.** A method that returns plain `data` where the call site expects `{success,data}` (or vice versa) **compiles** (call sites often use `any`/loose types) and **fails silently** at runtime — a button does nothing, a list renders empty. Mitigation: Task 2's inventory captures the expected shape per method *from the actual call site*, and each group task has a shape-assertion test (`expect(result).toEqual({ success: true, data: … })` vs `expect(result).toEqual([…])`). Do not skip the inventory.
2. **Result-vs-throw inconsistency.** Some call sites `if (result.success)` (must never throw), others `await` a bare value (must throw on error). Getting this backwards is the #1 silent-failure source. The inventory marks each method `RESULT` | `RAW-THROW` | `STRING|FALSE` | `BOOL` | `INLINE`.
3. **Pagination unwrap.** `recordings.getAll` call sites want `any[]`; the endpoint returns `{items,total}`. Unwrapping to `items` keeps existing sites working but loses `total`; the one or two sites that virtualize/page need a follow-up (Task 5b). Don't blanket-unwrap without checking who needs `total`.
4. **Channel-string + payload-shape drift on WS.** The callbacks in `useTranscriptionSync.ts`, `SpeakersPanel.tsx`, `useDeviceSubscriptions.ts`, `useDownloadOrchestrator.ts` destructure specific payload fields. The `/ws` payload MUST match what `webContents.send` sent (0c-1 preserves this). Assert payload shape in the WS task, not just channel routing.
5. **`credentials`/same-origin on writes.** 0c gates writes behind `requireSameOrigin`. If the SDK omits the same-origin header/credentials, every write 403s — but reads pass, so it looks "mostly working." Test a write path against a mock that asserts the header is present.
6. **Auth/401 handling.** A 401 from any endpoint (session expired) should route to the 0b login redirect, not surface as a generic error. Centralize in `http.ts`.
7. **★ Device groups are Phase 1.** Decide (with the operator) whether 0e ships `jensen`/`downloadService`/watcher groups as no-op stubs or waits for Phase 1. Either way they must not break typecheck.
8. **Deferred live validation.** Real Chrome/Edge WebUSB + real REST server behavior (cookies, CORS, range requests on the 0d media URL, WS upgrade through any proxy) is **NOT** verified by this plan's Vitest suite. **The operator runs the in-browser pass** (see Task 11). Mocks can be wrong about the wire; the plan says so explicitly.

---

## Task 1: SDK skeleton — `ElectronAPI` types lifted, `http.ts` transport, `installRestApi()` shell

**Files:**
- Create: `apps/electron/src/lib/electron-api/types.ts` (the `ElectronAPI` interface + all inline type aliases, lifted from `electron/preload/index.ts`)
- Create: `apps/electron/src/lib/electron-api/http.ts`
- Create: `apps/electron/src/lib/electron-api/index.ts` (exports `installRestApi()` + `restApi`)
- Test: `apps/electron/src/lib/electron-api/__tests__/http.test.ts`

**Interfaces:**
- Produces: `type ElectronAPI` (identical to preload's); `http` = `{ get, post, patch, put, del }` each returning `Promise<{ ok; status; data?; error? }>`; `installRestApi(): ElectronAPI` (assigns to `window.electronAPI`, returns it).
- Consumes: nothing yet (groups are added in later tasks; index.ts starts with an empty/partial object cast).

- [ ] **Step 1: Write the failing test** — `http.test.ts`:
  - `get('/api/x')` issues `fetch('<base>/api/x', { credentials: 'include', method: 'GET' })` and on a `200 {a:1}` resolves `{ ok: true, status: 200, data: { a: 1 } }`.
  - `post('/api/x', { b: 2 })` sets `Content-Type: application/json`, the same-origin write header (assert the header name agreed with 0b/0c, e.g. `X-Requested-With: hidock`), serializes the body, and on `400 { error: 'bad' }` resolves `{ ok: false, status: 400, error: 'bad' }`.
  - a `401` triggers the auth-redirect hook (assert a injected `onUnauthorized` callback fires; do not hard-navigate in tests).
  - a network throw resolves `{ ok: false, status: 0, error: <message> }` (never rejects — adapters decide throw-vs-Result).
  - Mock `fetch` with `vi.stubGlobal('fetch', vi.fn()...)`.

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run src/lib/electron-api/__tests__/http.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `http.ts`** — `fetch` wrapper with base URL (from `import.meta.env` / `window.location.origin`), `credentials: 'include'`, JSON body encode, write-header on non-GET, parse JSON, normalize to `{ok,status,data?,error?}`, `onUnauthorized` hook on 401, catch network errors → `{ok:false,status:0,error}`.

- [ ] **Step 4: Lift `ElectronAPI` types** — copy the `ElectronAPI` interface + every inline alias (`SuggestionView`, `DiarizationRun`, `SummarizationTemplate`, `TemplateInput`, `LatestRunView`, `PreviewSelectionResult`, `SuggestedTemplateEdits`) and the `import type` lines from `electron/preload/index.ts` into `types.ts`, adjusting import paths to renderer-relative. **Do not change any signature.**

- [ ] **Step 5: `index.ts` shell** — `installRestApi()` returns an object typed `ElectronAPI` (start as `{} as ElectronAPI`, filled in by subsequent tasks via composition `Object.assign(api, makeRecordingsGroup(http), …)`), assigns `window.electronAPI = api`.

- [ ] **Step 6: Run + typecheck** — `npx vitest run src/lib/electron-api && npm run typecheck` → http tests PASS; typecheck PASS (skeleton compiles even though groups are stubbed — keep the cast).

- [ ] **Step 7: Commit** — `feat(0e): renderer SDK skeleton — ElectronAPI types + http transport + install shell`

---

## Task 2: ★ Per-method shape-contract inventory (the safety net for every later task)

**Files:**
- Create: `apps/electron/src/lib/electron-api/CONTRACTS.md` (the inventory — a table, not prose)
- (No production code; this is the authoritative reference every group task tests against.)

**Why first:** the dominant 0e risk is returning the wrong shape per method (Risks 1–3). This task pins, for **every** method in `ElectronAPI`, (a) the REST endpoint from 0c, (b) the **call-site-required return shape**, classified `RESULT | RAW-THROW | STRING|FALSE | BOOL | INLINE | VOID | EVENT`, and (c) the file:line of a representative call site proving the classification.

- [ ] **Step 1: Enumerate every method** — from `types.ts`, list all `<group>.<method>` (and the top-level `on*` events). Expect ~150 callable methods + ~25 event subscriptions across ~40 groups.

- [ ] **Step 2: Classify each by reading its call sites** — for each method, `grep -rn "electronAPI.<group>.<method>" src` (and `api.<group>.<method>` where a local `const api = window.electronAPI` alias is used). Record the shape the call site destructures. Known anchors to seed the table:
  - `RESULT`: `contacts.getAll` (`useContactsStore.ts:55` → `if (result.success)`), all `projects.*` (`Projects.tsx:87`), `rag.*`, `outputs.getTemplates/generate`, `speakers.*`, `voiceprints.*`, `summarizationTemplates.list/create/update/...`, `transcripts.updateTurns/export`, `contacts.*`, `meetings.update`.
  - `RAW-THROW`: `recordings.getAll` (`useUnifiedRecordings.ts:420` → cast to `DatabaseRecording[]`), `meetings.getAll`, `transcripts.getByRecordingId`, `knowledge.getAll`, `actionables.getAll`, `queue.getItems`, `chat.getHistory`.
  - `STRING|FALSE`: `recordings.transcribe`, `recordings.addToQueue` (`useOperations.ts:66`).
  - `BOOL`: `recordings.delete`, `chat.clearHistory`, `syncedFiles.isFileSynced`.
  - `INLINE {success,…}`: `recordings.getCandidates/getMeetingsNearDate/selectMeeting/addExternalByPath`, `actionables.updateStatus/generateOutput`, `knowledge.update`, `recordings.cancelTranscription`, `recordings.validateTranscriptionConfig`.
  - `EVENT`: every `on*`/`onProgress`/`onStateUpdate` → `() => void` unsubscribe, dispatched from `/ws`.
  - `VOID`: `recordings.processQueue` (boolean), etc. — classify exactly.
  - `DROPPED/Electron-ism`: `storage.openFolder/openFile/revealInFolder`, `outputs.copyToClipboard`, `recordings.addExternal`, `outputs.saveToFile` (→ browser download), `app.restart` — mark how each is handled (removed / browser-native / download).
  - `PHASE-1 (out of scope)`: all `jensen.*`, all `downloadService.*`, `onRecordingAdded` — mark "left as-is / stub".

- [ ] **Step 3: Cross-check against the 0c endpoint tables** — for each non-deferred method, fill the REST column from `2026-06-26-hosted-hub-0c-rest-api-design.md` §3. Flag any method with **no** mapped endpoint (it was dropped or deferred — note which) and any endpoint that returns a shape needing extra unwrap (`{items,total}`, download body).

- [ ] **Step 4: Record the inventory** — `CONTRACTS.md` table columns: `group.method | REST | classification | unwrap notes | call-site proof (file:line)`. This file is the spec for Tasks 4–9.

- [ ] **Step 5: Commit** — `docs(0e): per-method shape-contract inventory (CONTRACTS.md)`

---

## Task 3: `WsClient` event multiplexer (replaces every `ipcRenderer.on`)

**Files:**
- Create: `apps/electron/src/lib/electron-api/ws.ts`
- Test: `apps/electron/src/lib/electron-api/__tests__/ws.test.ts`

**Interfaces:**
- Produces: `class WsClient { subscribe(channel: string, cb: (payload: any) => void): () => void; connect(): void; close(): void }`. One socket, per-channel listener sets, auto-reconnect with backoff, re-attach on reconnect.
- Consumes: native `WebSocket` (mocked in tests); the 0c-1 wire format `{channel, payload}`.

- [ ] **Step 1: Write the failing test** — `ws.test.ts` with a fake `WebSocket` (`vi.stubGlobal('WebSocket', FakeWS)`):
  - `subscribe('transcription:progress', cb)` then a frame `{channel:'transcription:progress', payload:{queueItemId:'q1',progress:42,stage:'asr'}}` invokes `cb({queueItemId:'q1',progress:42,stage:'asr'})` (exact payload pass-through).
  - two subscribers to the same channel both fire; the unsubscribe returned removes only that one.
  - a frame for an unsubscribed channel is ignored (no throw).
  - on socket `close`, the client reconnects (advance fake timers) and a post-reconnect frame still reaches the original subscriber (listeners survive reconnect).
  - malformed JSON frame does not throw.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `ws.ts`** — `Map<string, Set<cb>>`; single socket built lazily on first `subscribe`; `onmessage` parses + dispatches; `onclose` schedules reconnect (capped backoff); the same `Map` is reused so re-attach is automatic. URL is the `/ws` path on the same origin (`wss://`/`ws://` per `location.protocol`), cookie auth rides the upgrade (browser sends it; nothing to set).

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `feat(0e): WsClient event multiplexer for /ws (replaces ipcRenderer.on)`

---

## Task 4: Wire all `on*` / `onProgress` / `onStateUpdate` facade methods to `WsClient`

**Files:**
- Create: `apps/electron/src/lib/electron-api/groups/events.ts`
- Modify: `apps/electron/src/lib/electron-api/index.ts` (compose events group)
- Test: `apps/electron/src/lib/electron-api/__tests__/events.test.ts`

**Interfaces:**
- Produces: the top-level event methods (`onDomainEvent`, `onRecordingAdded`*, `onTranscriptionStarted/Progress/Completed/Failed/Cancelled/AllCancelled`, `onSecurityWarning`, `onActivityLogEntry`, `onVoiceprintCaptured`) **and** the group-nested ones (`downloadService.onStateUpdate`*, `integrity.onProgress`, `migration.onProgress`). Each delegates to `wsClient.subscribe(<channel>, cb)`.
- *Items marked* `*` *are Phase-1/device-coupled (`recording:new`, `download-service:state-update`) — see Task 2's PHASE-1 rows; wire them to `/ws` only if Phase 1 emits them there, else stub. Decide per Risk 7.*

- [ ] **Step 1: Write the failing test** — for each event method, assert it calls `wsClient.subscribe` with the **exact channel string** from the current preload (`transcription:progress`, `domain-event`, `voiceprint:captured`, `security-warning`, `activity-log:entry`, `integrity:progress`, `migration:progress`, …) and forwards the payload unchanged; the returned unsubscribe calls through.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `events.ts`** — map each facade method to `wsClient.subscribe(channel, cb)`. Channel strings copied verbatim from `electron/preload/index.ts` lines 916–1192 (the `ipcRenderer.on(<channel>)` arguments).

- [ ] **Step 4: Run → PASS; typecheck.**

- [ ] **Step 5: Commit** — `feat(0e): wire on*/onProgress event facade to WsClient`

---

## Task 5: REST groups batch A — recordings (read/lifecycle/link) + transcripts + queue + transcription control

**Files:**
- Create: `apps/electron/src/lib/electron-api/groups/recordings.ts`, `transcripts.ts`, `queue.ts`
- Modify: `index.ts` (compose)
- Test: `apps/electron/src/lib/electron-api/__tests__/recordings.test.ts`, `transcripts.test.ts`, `queue.test.ts`

**Maps to 0c-2 + 0c-2b endpoint tables.** Every method's classification + unwrap comes from `CONTRACTS.md` (Task 2).

- [ ] **Step 1: Write failing shape-assertion tests** — mock `http` (inject a fake), and for **each** method assert the returned shape against its contract. Representative musts:
  - `recordings.getAll()` → `GET /api/recordings` returns `{items:[…],total:N}`; SDK resolves the **bare array** `items` (RAW-THROW; on error it throws). Add a separate `total`-aware path only where a call site needs it (Task 5b).
  - `recordings.getById(id)` → `GET /api/recordings/:id`; `404` → throws (call sites await a value).
  - `recordings.delete(id)` → `DELETE /api/recordings/:id`; `2xx`→`true` (BOOL).
  - `recordings.deleteBatch(ids)` → `POST /api/recordings/batch-delete`; returns the inline `{success,deleted,failed,errors}` shape.
  - `recordings.transcribe(id)` / `addToQueue(id)` → `POST /api/recordings/:id/transcribe`; returns the **queue-item id string** on `2xx`, `false` on error (STRING|FALSE). *Verify `transcribe` vs `addToQueue` route per 0c-2b open question §9.*
  - `recordings.getCandidates/getMeetingsNearDate/selectMeeting/addExternalByPath` → INLINE `{success,data?,error?}`.
  - `transcripts.getByRecordingId(id)` → `GET /api/recordings/:id/transcript` (RAW); `updateTurns` → `PATCH …/transcript/turns` RESULT; `export` → download path (RESULT with the body or a Blob URL — match call site `SourceReader.tsx:778`).
  - `queue.getItems(status)` → `GET /api/queue?status=` (RAW array); `recordings.getTranscriptionStatus()` → `GET /api/queue/status` (inline `{isProcessing,pendingCount,processingCount}`); `cancelTranscription/cancelAll/retryAllFailed/processQueue/updateQueueItem/validateTranscriptionConfig` per contract.
  - **`db:*` dedup:** `recordings.getById` (channel `db:get-recording`) and `recordings.getAll` (`db:get-recordings`) point at the same REST routes as their domain twins (0c §1 channel-dedup) — one endpoint, the SDK methods both call it.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement the three group factories** — each method = `http.<verb>` + the contract's adapter. Keep signatures identical to `types.ts`.

- [ ] **Step 4: Run group tests → PASS; typecheck.**

- [ ] **Step 5: Commit** — `feat(0e): SDK groups — recordings/transcripts/queue over REST`

### Task 5b: Pagination-aware recordings list where a call site needs `total`

- [ ] Identify call sites that need `total`/paging (the virtualized `Library` list). Add an SDK method or option (`recordings.getPage({limit,offset,status,quality}) → {items,total}`) **without** breaking the bare-array `getAll`. Update only those call sites. Test both. Commit `feat(0e): paginated recordings list for virtualized Library`.

---

## Task 6: REST groups batch B — knowledge, synced-files, chat, meetings, calendar, contacts, projects (0c-3)

**Files:** Create `groups/{knowledge,syncedFiles,chat,meetings,calendar,contacts,projects}.ts`; modify `index.ts`; tests per group.

- [ ] **Step 1: Failing shape-assertion tests per method**, contracts from Task 2. Key musts:
  - `contacts.*` and `projects.*` are **RESULT** end-to-end (`if (result.success)` everywhere — never throw). `contacts.getAll` → `GET /api/contacts` → `{success:true,data:{contacts,total}}` matching `GetContactsResponse`.
  - `meetings.getAll` (RAW array), `meetings.getById` (RAW), `meetings.update` (RESULT), `meetings.getByIds` (RAW record).
  - `chat.getHistory` (RAW array), `chat.addMessage` (RAW), `chat.clearHistory` (BOOL).
  - `syncedFiles.*` — match exact shapes (`isFileSynced`→bool, `getSyncedFile`→row|undefined, `getAll`→array, `add`→id string, `remove`→bool).
  - `knowledge.getAll/getById/getByIds` (RAW), `knowledge.update` (INLINE `{success,error?}`).
  - **`db:*` dedup** for meetings/chat/synced/transcripts twins → single endpoint each.

- [ ] **Step 2–4: FAIL → implement → PASS + typecheck.**

- [ ] **Step 5: Commit** — `feat(0e): SDK groups — knowledge/synced/chat/meetings/calendar/contacts/projects`

---

## Task 7: REST groups batch C — rag, assistant, actionables, outputs, summarization, summarizationTemplates, quality (0c-4)

**Files:** Create the seven group files; modify `index.ts`; tests per group.

- [ ] **Step 1: Failing shape-assertion tests.** Key musts:
  - `rag.*` mostly **RESULT** (`status/chat/summarizeMeeting/findActionItems/cancel/...`), but `chatLegacy/stats/search/getChunks/indexTranscript` return **bare** shapes (RAW) — match each call site precisely. **`rag.chat` is full-response-over-HTTP** (no token streaming per 0c §1/§3); the SDK awaits the whole `RAGChatResponse`.
  - `outputs.getTemplates/generate/getByActionableId` → RESULT. **`outputs.saveToFile` → browser download** (Task 10), **`outputs.copyToClipboard` → `navigator.clipboard`** (Task 10) — these two do NOT hit REST.
  - `summarizationTemplates.*` → RESULT; `resummarizeWithTemplate` → inline `{success,error?}` (it currently routes through `transcription:resummarize`; map to `POST /api/recordings/:id/resummarize {templateId}`).
  - `actionables.getAll/getByMeeting` (RAW arrays), `updateStatus/generateOutput` (INLINE).
  - `quality.*` per contract (mostly RAW/any).
  - `summarization.listModels/testConnection` → inline `{success,models?/error?}`.

- [ ] **Step 2–4: FAIL → implement → PASS + typecheck.**

- [ ] **Step 5: Commit** — `feat(0e): SDK groups — rag/assistant/actionables/outputs/summarization/templates/quality`

---

## Task 8: REST groups batch D — storage(meta), config, voiceprints, speakers, diarization, integrity, app, deviceCache, migration, storagePolicy (0c-5)

**Files:** Create the group files; modify `index.ts`; tests per group.

- [ ] **Step 1: Failing shape-assertion tests.** Key musts:
  - `speakers.*` and `voiceprints.*` → **RESULT** throughout (e.g. `SpeakersPanel.tsx` does `await …voiceprints.delete(id)` then checks `.success`).
  - `diarization.getLatestRun/getRunsForRecording` → RESULT.
  - `config.get/getValue` (RAW any), `config.set/updateSection` (RAW any; **admin** route per 0c-5 §3).
  - `integrity.*` → mix of RAW (runScan/getReport) + INLINE (repairIssue/repairAll); progress via WS (`integrity:progress`, Task 4). **admin** routes.
  - `migration.*` → RAW/BOOL + `onProgress` via WS (`migration:progress`, Task 4). **admin** routes.
  - `app.info` → RAW object. **`app.restart` is DROPPED** (0c §4) — implement as a no-op that resolves (or remove + update the lone call site).
  - `storage.getInfo` (RAW). **`storage.openFolder/openFile/revealInFolder` DROPPED** → Task 10. **`storage.readRecording/saveRecording/deleteRecording` DROPPED** (media via 0d / upload via 0c-2) → ensure no remaining call site depends on them (grep; fix any).
  - `deviceCache.*` → `GET/PUT/DELETE /api/device-cache` (RAW). *(deviceCache is server-side metadata, not the WebUSB device path — it stays.)*
  - `storagePolicy.*` → RAW/any per contract.

- [ ] **Step 2–4: FAIL → implement → PASS + typecheck.**

- [ ] **Step 5: Commit** — `feat(0e): SDK groups — storage/config/voiceprints/speakers/diarization/integrity/app/deviceCache/migration/storagePolicy`

---

## Task 9: Device groups (Phase-1 boundary) — keep typecheck green

**Files:** Create `groups/device.ts` (jensen + downloadService); modify `index.ts`.

- [ ] **Step 1: Decide (Risk 7).** Per the operator's call: either (a) **no-op stubs** that satisfy `ElectronAPI` and reject/return safe defaults with a clear `'device path is Phase 1'` marker, **or** (b) leave these groups bound to the Phase-1 WebUSB bridge if it already exists. This plan implements (a) unless told otherwise.

- [ ] **Step 2: Test** — assert every `jensen.*`/`downloadService.*` method exists and (for stubs) resolves/rejects per the chosen contract, and that `onStateUpdate`/`onConnect`/etc. return a no-op unsubscribe (so subscribing components don't crash).

- [ ] **Step 3: Implement; run; typecheck.**

- [ ] **Step 4: Commit** — `feat(0e): device groups stubbed at the Phase-1 boundary (jensen/downloadService)`

---

## Task 10: Remove renderer Electron-isms (window chrome, native dialogs, clipboard, open/reveal, media URL)

**Files (modify):**
- `apps/electron/src/utils/audioUtils.ts` — `getMediaUrl` → 0d HTTP media URL
- `apps/electron/src/components/layout/Layout.tsx` — drop `titlebar-drag-region`/`titlebar-no-drag`/window-control chrome
- `apps/electron/src/pages/Library.tsx` — `recordings.addExternal()` → `<input type=file>` upload to `POST /api/recordings/upload`; `storage.openFolder` removed
- `apps/electron/src/pages/Settings.tsx` — `storage.openFolder` removed
- `apps/electron/src/features/library/components/SourceReader.tsx` — `storage.openFile`/`revealInFolder` removed; `transcripts.export` → browser download
- `apps/electron/src/pages/Actionables.tsx` — `outputs.copyToClipboard` → `navigator.clipboard.writeText`
- `apps/electron/src/pages/Chat.tsx` — `outputs.saveToFile` → browser download (anchor + Blob)
- Any `shell.openExternal` site → `window.open(url, '_blank')`
- Tests: update the affected component tests; add a `getMediaUrl` test.

- [ ] **Step 1: `getMediaUrl` test + impl** — assert it returns the 0d media endpoint URL form (e.g. `${origin}/api/media?p=<encoded>` or the 0d-agreed shape) and **not** `hidock-media://`. Update its doc comment.
- [ ] **Step 2: Titlebar** — remove drag-region markup/classes and any min/max/close buttons; verify Layout test still renders.
- [ ] **Step 3: Upload flow** — replace `addExternal()` with a file-input → `POST /api/recordings/upload` (multipart) call; on success refresh the list. Test the handler builds the request (mock `http`).
- [ ] **Step 4: Downloads** — `transcripts.export` + `outputs.saveToFile` → fetch the body and trigger an anchor download (`URL.createObjectURL(new Blob([...]))`); no native dialog. Test the anchor/Blob path.
- [ ] **Step 5: Clipboard** — `outputs.copyToClipboard` → `navigator.clipboard.writeText` (mock it).
- [ ] **Step 6: Open/reveal** — remove `storage.openFolder/openFile/revealInFolder` call sites; replace with a download link or hide the affordance. Grep to confirm zero remaining renderer callers of the dropped methods.
- [ ] **Step 7: Run affected tests + typecheck.**
- [ ] **Step 8: Commit** — `feat(0e): strip renderer Electron-isms (media URL, titlebar, dialogs, clipboard, open/reveal)`

---

## Task 11: Bootstrap swap + full-suite gate + operator hand-off for live browser validation

**Files:**
- Modify: the renderer entry (`apps/electron/src/main.tsx` or equivalent bootstrap) to call `installRestApi()` **before** the React tree mounts, so `window.electronAPI` is the REST SDK from frame one.
- Modify: `apps/electron/src/lib/electron-api/http.ts` — wire `onUnauthorized` → 0b login redirect.
- Create: `apps/electron/src/lib/electron-api/README.md` — the operator's live-validation checklist (deferred pass).

- [ ] **Step 1: Bootstrap** — install the SDK at startup; connect the `WsClient`. Ensure no `ipcRenderer`/`window.electronAPI` provided by preload is required (the preload bridge is the desktop path; hosted uses this SDK). Test that after `installRestApi()`, `window.electronAPI.contacts.getAll` is a function and a mocked `200` flows through as `{success:true,data}`.
- [ ] **Step 2: 401 redirect** — assert a 401 routes to the 0b login URL (mocked navigation).
- [ ] **Step 3: Full gate** — `npm run typecheck && npm run lint && npm run test:run` → all green. Fix any call site the SDK shape change surfaced (these are the silent-contract bugs the inventory was built to catch).
- [ ] **Step 4: Write the operator checklist (`README.md`)** — explicitly: *Vitest mocks the wire; live behavior is unverified.* The operator must, against the real 0b/0c/0c-1/0d server in **Chrome and Edge**:
  - Log in (0b OIDC), confirm session cookie rides every `fetch` (`credentials: include`) and the `/ws` upgrade.
  - Exercise a read (recordings list), a `RESULT` write (create contact/project), a `STRING|FALSE` action (transcribe), an INLINE action (link meeting), a download (transcript export), an upload (`POST /api/recordings/upload`).
  - Confirm `/ws` events arrive (start a transcription, watch progress) and survive a reconnect (kill/restore the socket).
  - Play audio (the **0d media URL** with HTTP range — scrub a large file; confirm it streams, not full-load).
  - Confirm **WebUSB device picker** still works in Chrome/Edge (Phase-1 path, unchanged by 0e) and that device groups don't crash the UI.
  - Note CORS/proxy/WSS gotchas to feed back into 0f (Docker) config.
- [ ] **Step 5: Commit** — `feat(0e): install REST SDK at bootstrap + 401 redirect + operator validation checklist`

---

## Self-Review

**Spec coverage:** single `callIPC` chokepoint + ~40 groups reimplemented as a typed SDK over REST → Tasks 1, 5–9 (groups), with the `http` transport in Task 1. `on*`/`onProgress`/`onStateUpdate` over the `/ws` broadcaster → Tasks 3–4. `hidock-media://` → 0d media URL, window chrome/titlebar, native dialogs, clipboard, open/reveal, `shell.openExternal` → Task 10. Bootstrap swap + 401 → Task 11. The browser WebUSB device picker / `jensen:*` / `downloadService:*` stay Phase-1 → Task 9 (boundary stubs).

**The central risk is called out explicitly and structurally mitigated:** Risk 1 (★) names the ~150 per-method shape contracts as the dominant failure mode; Task 2 builds the inventory (`CONTRACTS.md`) that every group task tests against; each group task is a TDD shape-assertion suite. The Result-vs-throw / pagination-unwrap / WS-payload sub-risks (2–4) are itemized with concrete anchor call sites.

**Live validation is explicitly deferred to the operator:** Risk 8 + Task 11 Step 4 state that Vitest mocks the wire and that real Chrome/Edge WebUSB + real REST/WS/0d-media behavior is the operator's manual pass, with a concrete checklist.

**Grounding:** the `ElectronAPI` interface, the single `callIPC`, and the channel strings are lifted from `electron/preload/index.ts` (read in full). Shape classifications are anchored to real call sites read during planning (`useContactsStore.ts:55`, `Projects.tsx:87`, `useOperations.ts:66`, `useUnifiedRecordings.ts:420`, `SpeakersPanel.tsx`, `SourceReader.tsx:778`, `Chat.tsx:490`, `Actionables.tsx:168`, `Library.tsx:505`). The media URL builder is `src/utils/audioUtils.ts:96`. REST endpoints are from `2026-06-26-hosted-hub-0c-rest-api-design.md` §3; the WS wire format `{channel,payload}` and channel set are from `2026-06-26-hosted-hub-0c1-ws-broadcaster.md`.

**Out of scope (and why):** no server routes (0b/0c/0c-1/0d own them); no real-server run (mocks + deferred operator pass); no Phase-1 WebUSB implementation (Task 9 only keeps the boundary typecheck-green); Docker/0f config gotchas are fed back from the operator pass, not solved here.

**Open decisions flagged for the operator:** (Risk 7) device groups as no-op stubs vs. wait for Phase-1 WebUSB; (0c-2b §9) `transcribe` vs `addToQueue` single route vs split; the exact same-origin write header name agreed with 0b/0c; the exact 0d media URL form for `getMediaUrl`.
