# Hosted Hub — 0c REST API Surface Design (0c-2 … 0c-5)

**Status:** Design for review (no code). Revised after an antagonistic review. Pauses here for your approval; on approval each batch becomes a bite-sized TDD execution plan (via writing-plans) at execution time.

**Scope:** Port the ~200 Electron IPC channels (the `electronAPI` surface) to REST routers on the 0b Fastify server, reusing the 0c-1 WS broadcaster for server→client events. The renderer (0e) reimplements its `window.electronAPI.<group>.<method>` facade to call these endpoints.

> **Revision note (post-review).** Changes from the first draft: (1) error model rebuilt around Fastify `setErrorHandler` + typed errors (string-error → status-code sniffing is gone); (2) SDK re-wrap honestly framed as ~150 per-method shape contracts, not one rule; (3) action endpoints blessed as first-class pragmatic REST — a separate `/rpc` channel was considered and **rejected** (fragments the API; SDK hides URLs); (4) `GET /api/recordings` paginated; (5) `rag:chat` returns full response over HTTP (no token streaming — the broadcast WS can't correlate per-request); (6) **file-upload ingest pulled forward** so the hub isn't un-fillable before Phase 1; (7) overloaded `GET /api/recordings` split; (8) `transcripts:updateTurns` owner assigned; (9) body-size limits noted; (10) recordings batch pre-split.

---

## 1. Conventions (shared by every router)

- **Base path `/api`.** One Fastify plugin per domain in `electron/server/routes/<domain>.ts`, registered in `buildApp` after the admin routes. Reuses the 0b guards: **reads** = `preHandler: [requireAuth]`; **writes/actions** = `[requireAuth, requireSameOrigin]`. Destructive/global domains (`config` writes, `integrity`, `migration`) add `requireAdmin` (flagged per-domain).

- **Error model (rebuilt).** Routes are **thin controllers**: call the service, `return` the data on success; on failure `throw` a typed error from `routes/_errors.ts` — `NotFoundError` (404), `BadRequestError` (400), `ConflictError` (409). A single Fastify `setErrorHandler` maps these + `ZodError` (→400) to the JSON envelope `{ error, details? }` with the correct status; any unexpected throw → `500 { error:'internal' }` (message not leaked). **Status codes come from the route's explicit logic, never from sniffing a string** — e.g. a `getById` controller does `const r = svc(id); if (!r) throw new NotFoundError(); return r`. This replaces the first draft's untenable "one `send()` helper derives 404/400/500 from `error` strings."

- **Result unwrapping is per-route, explicit.** Handlers return heterogeneous shapes (`Result<T>`, inline `{success,data,error}`, raw arrays, legacy `throw`). Each controller unwraps its own service's shape at the call site — `const r = await svc(...); if (!r.success) throw new BadRequestError(r.error); return r.data` — rather than a global heuristic that can't tell a raw `{success:…}` row from an envelope.

- **Renderer SDK is ~150 per-method shape contracts (0e), not one re-wrap rule.** The REST layer returns plain data on `200` and `{error}` on `4xx/5xx`. The 0e facade must make each `electronAPI.<group>.<method>` return **exactly** the shape its existing call sites destructure (some expect `Result<T>`, some a raw array). This is real 0e work; the design does not pretend it's uniform.

- **Action endpoints are first-class pragmatic REST.** ~42 channels are RPC verbs (cancel, retry, sync, scan, assess, run-migration…). These map to `POST /api/<domain>/<verb>` (collection) or `POST /api/<domain>/:id/<verb>` (entity) — standard, legitimate REST. **A separate `/rpc` dispatch endpoint was considered and rejected:** it would split the API into two styles for marginal benefit (the renderer SDK hides URLs, and a future external client is better served by one consistent REST style). *Flag if you'd rather have the `/rpc` split.*

- **Validation.** Zod (`z.email()`, v4) on `body`/`params`/`query`.

- **Pagination.** List endpoints accept `?limit&offset`; paginated lists return `{ items, total }`. **`GET /api/recordings` is paginated** (default `limit=200`) — the renderer already virtualizes (`@tanstack/react-virtual`) and adopts paging in 0e. Lists that are inherently small (templates, projects) may return a plain array.

- **Body size.** Routes carrying large payloads (`POST /api/rag/index`, `PATCH /api/recordings/:id/transcript/turns`) set a raised per-route `bodyLimit` (e.g. 16 MB) so a long transcript doesn't 413 against Fastify's 1 MB default.

- **Server→client events stay on `/ws`** (0c-1) on their existing channel strings (`transcription:*`, `domain-event`, `integrity:progress`, `migration:progress`, `voiceprint:captured`). Long actions return their final result over HTTP and broadcast progress over WS. **No token streaming for `rag:chat`** (see §3/§5): the 0c-1 broadcaster fans to all of a user's sockets with no per-request correlation, so streaming would leak one tab's chat into another. `rag:chat` returns the full answer over HTTP; streaming is a later enhancement that needs WS subscription IDs.

- **Channel dedup.** `db:*` duplicates of domain channels (`db:get-recordings`≈`recordings:getAll`, `db:get-transcript`≈`transcripts:getByRecordingId`, `db:*synced*`, `db:get-chat-history`) map to **one** endpoint each; the SDK points both facade methods at it.

---

## 2. Batch decomposition

0c-2 builds the shared scaffolding (`routes/_errors.ts` typed errors, the `setErrorHandler`, the router-registration pattern, a route-test harness) plus the recordings **reads + lifecycle + upload**. Recordings is the largest domain, so its transcription-control/transcripts/queue half is split into 0c-2b.

| Batch | Domains | ~Endpoints |
|---|---|---|
| **0c-2** | scaffolding + **recordings (read/lifecycle/delete/link), recordings upload ingest** | ~18 |
| **0c-2b** | **transcripts, queue + transcription-control actions** | ~18 |
| **0c-3** | **knowledge, synced-files, chat, meetings, calendar, contacts, projects** | ~45 |
| **0c-4** | **rag, assistant, actionables, outputs, summarization, summarizationTemplates, quality** | ~45 |
| **0c-5** | **storage(meta), config, voiceprints, speakers, diarization, integrity, app, deviceCache, migration, storagePolicy** | ~45 |

---

## 3. Endpoint tables

### 0c-2 — Recordings (read / lifecycle / ingest)

| IPC channel(s) | REST |
|---|---|
| `recordings:getAll`, `db:get-recordings` | `GET /api/recordings?limit&offset&status&quality` → `{items,total}` (paginated) |
| `quality:get-by-quality` | `GET /api/recordings?quality=` (same list, filtered — not a separate route) |
| `recordings:getAllWithTranscripts` | `GET /api/recordings/with-transcripts?limit&offset` (distinct return shape `RecordingWithTranscript[]`) |
| `recordings:getById`, `db:get-recording` | `GET /api/recordings/:id` (404 if absent) |
| `recordings:getForMeeting`, `db:get-recordings-for-meeting` | `GET /api/meetings/:id/recordings` |
| `recordings:delete` | `DELETE /api/recordings/:id` |
| `recordings:deleteBatch` | `POST /api/recordings/batch-delete` `{ids}` |
| `recordings:updateStatus`, `recordings:updateRecordingStatus`, `db:update-recording-status` | `PATCH /api/recordings/:id` `{status}` |
| `recordings:updateTranscriptionStatus` | `PATCH /api/recordings/:id` `{transcriptionStatus}` |
| `recordings:linkToMeeting`, `db:link-recording-to-meeting` | `POST /api/recordings/:id/link-meeting` `{meetingId,confidence?,method?}` |
| `recordings:unlinkFromMeeting` | `POST /api/recordings/:id/unlink-meeting` |
| `recordings:selectMeeting` | `POST /api/recordings/:id/select-meeting` `{meetingId\|null}` |
| `recordings:getCandidates` | `GET /api/recordings/:id/candidates` |
| `recordings:getMeetingsNearDate` | `GET /api/recordings/meetings-near-date?date=` |
| **NEW — file-upload ingest** (replaces `recordings:addExternal` for hosted) | `POST /api/recordings/upload` (multipart audio) → store under `/data/recordings`, insert row, enqueue transcription. Unblocks an otherwise un-fillable hub before Phase-1 device sync. Shares `/data` storage with the Phase-1 WebUSB upload but is a simpler direct multipart upload. |

### 0c-2b — Transcripts / Queue / Transcription control

| IPC channel(s) | REST |
|---|---|
| `recordings:getTranscript`, `db:get-transcript`, `transcripts:getByRecordingId` | `GET /api/recordings/:id/transcript` |
| `transcripts:getByRecordingIds`, `db:get-transcripts-by-recording-ids` | `POST /api/transcripts/by-recording-ids` `{ids}` |
| `transcripts:search`, `db:search-transcripts` | `GET /api/transcripts/search?q=` |
| `transcripts:updateTurns` | `PATCH /api/recordings/:id/transcript/turns` `{turns}` — **owned by 0c-2b** (handler currently lives in `speakers-handlers.ts`; the controller calls the same service fn). Raised `bodyLimit`. |
| `recordings:transcribe`, `recordings:addToQueue` | `POST /api/recordings/:id/transcribe` — **verify the two channels are behaviorally identical at impl time; if not, keep `?queue=1` or a second route.** |
| `transcription:resummarize` | `POST /api/recordings/:id/resummarize` `{templateId?}` |
| `transcription:isSummaryStale` | `GET /api/recordings/:id/summary-stale` |
| `transcription:cancel` / `transcription:retry` | `POST /api/recordings/:id/transcription/{cancel,retry}` |
| `transcription:getQueue`, `queue:getItems`, `db:get-queue` | `GET /api/queue?status=` |
| `transcription:updateQueueItem` | `PATCH /api/queue/:id` `{status,errorMessage?}` |
| `recordings:processQueue` | `POST /api/queue/process` |
| `transcription:cancelAll` / `transcription:retryAll` | `POST /api/queue/{cancel-all,retry-failed}` |
| `recordings:getTranscriptionStatus` | `GET /api/queue/status` |
| `recordings:start/stopTranscriptionProcessor` | `POST /api/queue/processor/{start,stop}` |
| `transcription:validateConfig` | `GET /api/transcription/config/validate` |

### 0c-3 — Knowledge / Synced files / Chat / Meetings / Calendar / Contacts / Projects
*(unchanged from the first draft except `chat`/`synced` dedup notes; see §3 of the committed history. Endpoints:)*

| IPC channel(s) | REST |
|---|---|
| `knowledge:getAll` | `GET /api/knowledge?limit&offset&status&quality&category` |
| `knowledge:getById` / `getByIds` / `update` | `GET /api/knowledge/:id` · `POST /api/knowledge/by-ids` · `PATCH /api/knowledge/:id` |
| `syncedFiles:*` (+ `db:*synced*`) | `GET /api/synced-files` · `GET /api/synced-files/filenames` · `GET /api/synced-files/lookup?filename=` · `POST /api/synced-files` · `DELETE /api/synced-files?filename=` |
| `chat:*` (+ `db:*chat*`) | `GET /api/chat/history?limit=` · `POST /api/chat/messages` · `DELETE /api/chat/history` |
| `meetings:*` (+ `db:get-meeting[s]*`) | `GET /api/meetings?startDate&endDate` · `GET /api/meetings/:id` · `POST /api/meetings/by-ids` · `GET /api/meetings/:id/details` · `PATCH /api/meetings/:id` |
| `calendar:*` | `GET /api/calendar/settings` · `PATCH /api/calendar/settings` (url/auto-sync/interval) · `GET /api/calendar/last-sync` · `POST /api/calendar/sync` (+ `?clear=1`) |
| `contacts:*` | `GET /api/contacts?search&type&limit&offset` · `GET /api/contacts/:id` · `POST /api/contacts` · `PATCH /api/contacts/:id` · `DELETE /api/contacts/:id` · `GET /api/meetings/:id/contacts` · `GET`/`PUT /api/contacts/self` |
| `projects:*` | `GET /api/projects?…` · `GET /api/projects/:id` · `POST` · `PATCH /api/projects/:id` · `DELETE /api/projects/:id` · `POST`/`DELETE /api/meetings/:id/projects/:projectId` · `GET /api/meetings/:id/projects` |

### 0c-4 — RAG / Assistant / Actionables / Outputs / Summarization / Templates / Quality

| IPC channel(s) | REST |
|---|---|
| `rag:status` / `rag:stats` | `GET /api/rag/status` · `GET /api/rag/stats` |
| `rag:chat`, `rag:chat-legacy` | `POST /api/rag/chat` — **full response over HTTP, no token streaming** (see §1/§5) |
| `rag:cancel` / `clear-session` / `removeLastMessages` | `POST /api/rag/{cancel,session/clear,session/trim}` |
| `rag:summarize-meeting` / `find-action-items` | `POST /api/rag/{summarize-meeting,find-action-items}` |
| `rag:search` / `globalSearch` | `GET /api/rag/search?q&limit&scope=` |
| `rag:get-chunks` / `index-transcript` | `GET /api/rag/chunks` · `POST /api/rag/index` (raised `bodyLimit`) |
| `assistant:*` | `GET`/`POST /api/assistant/conversations` · `DELETE`/`PATCH /api/assistant/conversations/:id` · `GET`/`POST /api/assistant/conversations/:id/messages` · `GET`/`POST`/`DELETE /api/assistant/conversations/:id/context` |
| `actionables:*` | `GET /api/actionables?status=` · `GET /api/meetings/:id/actionables` · `PATCH /api/actionables/:id` · `POST /api/actionables/:id/generate-output` |
| `outputs:getTemplates` / `generate` / `getByActionableId` | `GET /api/outputs/templates` · `POST /api/outputs/generate` · `GET /api/actionables/:id/output` |
| `outputs:saveToFile` | `POST /api/outputs/download` → `200` + body + `Content-Disposition` (browser download; no native dialog) |
| `summarization:listModels` / `testConnection` | `GET /api/summarization/models` · `POST /api/summarization/test-connection` |
| `summarizationTemplates:*` | `GET /api/summarization-templates` · `POST` · `PATCH /api/summarization-templates/:id` (incl. `{enabled}`) · `DELETE /api/summarization-templates/:id` · `GET /api/recordings/:id/template-{run,selection}` · `POST /api/recordings/:id/accept-suggested-template` |
| `quality:get` / `set` / `auto-assess` | `GET`/`PUT /api/recordings/:id/quality` · `POST /api/recordings/:id/quality/auto-assess` |
| `quality:batch-auto-assess` / `assess-unassessed` | `POST /api/quality/{batch-assess,assess-unassessed}` |

### 0c-5 — Storage(meta) / Config / Voiceprints / Speakers / Diarization / Integrity / App / DeviceCache / Migration / StoragePolicy

| IPC channel(s) | REST |
|---|---|
| `storage:get-info` | `GET /api/storage/info` |
| `config:get` / `get-value` | `GET /api/config` (+ `?key=`) |
| `config:set` / `update-section` | `PATCH /api/config` *(admin)* |
| `voiceprints:*` | `GET /api/contacts/:id/voiceprints` · `GET /api/voiceprints?recordingId&fileLabel&contactId` · `PATCH /api/voiceprints/:id` `{enabled}` · `DELETE /api/voiceprints/:id` · `DELETE /api/voiceprints?contactId=` · `DELETE /api/voiceprints` |
| `speakers:*` | `GET /api/recordings/:id/speakers` · `GET /api/recordings/:id/speaker-suggestions` · `PUT`/`DELETE /api/recordings/:id/speakers/:fileLabel` · `POST /api/recordings/:id/speakers/{merge,reassign}` · `POST /api/recordings/:id/speakers/:fileLabel/set-self` · `POST /api/speaker-suggestions/:id/{dismiss,accept}` |
| `diarization:*` | `GET /api/recordings/:id/diarization` (+ `?all=1`) |
| `integrity:*` | `GET /api/integrity/report` *(admin)* · `POST /api/integrity/<action>` *(admin; progress over `/ws`)* |
| `app:info` | `GET /api/app/info` |
| `deviceCache:*` | `GET`/`PUT`/`DELETE /api/device-cache` |
| `migration:getStatus` / `previewCleanup` | `GET /api/migration/{status,preview}` *(admin)* |
| `migration:runCleanup` / `runV11` / `rollbackV11` | `POST /api/migration/<action>` *(admin; progress over `/ws`)* |
| `storagePolicy:*` | `GET /api/storage-policy/...` (by-tier/stats/cleanup-suggestions) · `POST /api/storage-policy/<action>` (execute-cleanup/initialize-untiered/assign-tier) |

---

## 4. Deferred / dropped (the real product decisions)

- **Binary/media** (`storage:read-recording` base64, `save-recording`) → **dropped from REST**; superseded by the 0d media range endpoint + the new `POST /api/recordings/upload` ingest. No base64-over-JSON.
- **File-save dialogs** → endpoint returns content as a browser download (`transcripts:export`, `outputs:saveToFile`). `outputs:copyToClipboard` → dropped (renderer concern). `transcripts:export` → `POST /api/recordings/:id/transcript/export?format=` returning the file body. *(Moved into 0c-2b/0c-4 as download routes.)*
- **Native open/reveal** (`storage:open-folder`/`open-file`/`reveal-in-folder`) → **dropped** (no server desktop).
- **Device domain — OUT of 0c** — `jensen:*` and `downloadService:*` are **Phase 1** (browser WebUSB). The recording **watcher** (`recordings:get/start/stopWatcher`, `scanFolder`) is also Phase-1/device-coupled → deferred. *(But generic file ingest is NOT deferred — see the new upload route in §3.)*
- **`app:restart`** → **dropped** (no "relaunch the desktop app"; container restart policy handles process lifecycle).
- **`*:onProgress` / `on*` event subscriptions** (`onDomainEvent`, `onTranscription*`, `onVoiceprintCaptured`, `migration:onProgress`, `integrity:onProgress`, `jensen:on*`) → **WS message handlers in 0e**, keyed off the broadcast `{channel}`. Not REST.

---

## 5. Risks / open questions (post-revision)

1. **Resolved — error model.** Typed errors + `setErrorHandler` give correct, route-driven status codes (no string sniffing).
2. **Resolved — pagination.** `GET /api/recordings` paginates; renderer virtualizes/pages in 0e (a real 0e change — flagged).
3. **Resolved — rag:chat.** Full response over HTTP; streaming deferred until `/ws` gains per-request correlation (avoids cross-tab token leakage).
4. **Resolved — un-fillable hub.** `POST /api/recordings/upload` lands in 0c-2 so the hosted hub can ingest audio without the device.
5. **Standing decision — REST everywhere (no `/rpc`).** Action endpoints are pragmatic-REST POSTs; a hybrid `/rpc` was rejected to keep one API style. **This is your B-vs-A call — veto if you want the `/rpc` split for the ~42 action channels.**
6. **Standing decision — admin-gating** of `config` writes, `integrity`, `migration`. Confirm `requireAdmin` (vs any member).
7. **0e shape contracts.** The renderer facade is ~150 per-method return-shape contracts; the heaviest, most error-prone part of 0e. Not a 0c blocker, but the largest downstream risk.
8. **Volume.** ~150 endpoints across 5 batches (recordings now pre-split into 0c-2/0c-2b). Each batch ≈ a 0b-sized run.
9. **`transcribe` ≡ `addToQueue`?** Verify at impl; split if they differ.

---

## 6. On approval

Each batch → its own bite-sized TDD execution plan (writing-plans), executed subagent-driven with the plan→antagonistic-review→execute→review loop. 0c-2 carries the scaffolding (`routes/_errors.ts`, `setErrorHandler`, router registration, `app.inject` test harness). Domains test against a real better-sqlite3 DB; WS-emitting actions assert via the 0c-1 broadcaster.
