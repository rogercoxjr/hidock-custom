# Hosted Hub — 0c REST API Surface Design (0c-2 … 0c-5)

**Status:** Design for review (no code). Pauses here for your approval of the API surface; on approval each batch becomes a bite-sized TDD execution plan (via writing-plans) at execution time.

**Scope:** Port the ~200 Electron IPC channels (the `electronAPI` surface) to REST routers on the 0b Fastify server, reusing the 0c-1 WS broadcaster for server→client events. The renderer (0e) reimplements its `window.electronAPI.<group>.<method>` facade to call these endpoints — so the facade method→endpoint mapping defined here makes 0e mechanical.

---

## 1. Conventions (shared by every router)

- **Base path `/api`.** One Fastify plugin per domain in `electron/server/routes/<domain>.ts`, registered in `buildApp` after the admin routes. Reuses the 0b guards: **reads** = `preHandler: [requireAuth]`; **writes/actions** = `[requireAuth, requireSameOrigin]`. (Admin-only domains — e.g. `integrity`, `migration`, `config` writes — add `requireAdmin`; flagged per-domain.)
- **Result→HTTP envelope.** Most handlers return `Result<T>` / `{ success, data, error }` / raw values. A single `send(reply, result)` helper in `routes/_result.ts` normalizes: `success:false` → status by error kind (validation 400, not-found 404, else 500) + `{ error }`; `success:true` or raw → `200` + the unwrapped `data`. The renderer SDK (0e) re-wraps `200`→`{success:true,data}` and `4xx/5xx`→`{success:false,error}` so existing call sites are unchanged.
- **Validation.** Zod (`z.email()`, etc. — v4) on `body`/`params`/`query`; parse failure → `400 { error:'invalid', details }`.
- **Resource conventions.** `GET /api/<r>` (list, filters via query → `{ items, total }` where the handler already paginates), `GET /api/<r>/:id`, `POST /api/<r>` (create), `PATCH /api/<r>/:id` (update), `DELETE /api/<r>/:id`. **RPC-ish ACTIONs** → `POST /api/<r>/:id/<verb>` (per-entity) or `POST /api/<r>/<verb>` (collection-level). Sub-resources nest (`/api/recordings/:id/transcript`).
- **IDs in the path** for entity routes (UUIDs are path-safe); **filenames/emails/free text in the body or query** (not path).
- **Server→client events stay on `/ws`** (0c-1). Long-running ACTIONs (transcribe, calendar sync, integrity scan, migration, rag chat) return their final result over HTTP and stream progress over the existing WS channels (`transcription:*`, `domain-event`, `integrity:progress`, `migration:progress`, `voiceprint:captured`). No SSE.
- **Channel dedup.** The renderer reaches the same data through two facade groups in places (e.g. `recordings:getAll` AND `db:get-recordings`; `transcripts:getByRecordingId` AND `db:get-transcript`; `syncedFiles:*` AND `db:*synced*`; `chat:getHistory` AND `db:get-chat-history`). These map to **one** REST endpoint each; the SDK points both facade methods at it. No duplicate endpoints.

---

## 2. Batch decomposition

0c-2 also builds the shared scaffolding (`_result.ts` helper, the Zod error handler, the router-registration pattern, a route test harness) that 0c-3/4/5 reuse. Recordings is by far the largest domain, so 0c-2 is scaffolding + recordings/transcripts/queue only.

| Batch | Domains | ~Endpoints |
|---|---|---|
| **0c-2** | scaffolding + **recordings, transcripts, queue/transcription-control** | ~45 |
| **0c-3** | **knowledge, synced-files, chat, meetings, calendar, contacts, projects** | ~45 |
| **0c-4** | **rag, assistant, actionables, outputs, summarization, summarizationTemplates, quality** | ~45 |
| **0c-5** | **storage(meta), config, voiceprints, speakers, diarization, integrity, app, deviceCache, migration, storagePolicy** | ~45 |

---

## 3. Endpoint tables

### 0c-2 — Recordings / Transcripts / Queue

| IPC channel(s) | REST |
|---|---|
| `recordings:getAll`, `db:get-recordings` | `GET /api/recordings` |
| `recordings:getById`, `db:get-recording` | `GET /api/recordings/:id` |
| `recordings:getForMeeting`, `db:get-recordings-for-meeting` | `GET /api/meetings/:id/recordings` |
| `recordings:getAllWithTranscripts` | `GET /api/recordings?withTranscripts=1` |
| `recordings:delete` | `DELETE /api/recordings/:id` |
| `recordings:deleteBatch` | `POST /api/recordings/batch-delete` `{ids}` |
| `recordings:updateStatus`, `recordings:updateRecordingStatus`, `db:update-recording-status` | `PATCH /api/recordings/:id` `{status}` |
| `recordings:updateTranscriptionStatus` | `PATCH /api/recordings/:id` `{transcriptionStatus}` |
| `recordings:linkToMeeting`, `db:link-recording-to-meeting` | `POST /api/recordings/:id/link-meeting` `{meetingId,confidence?,method?}` |
| `recordings:unlinkFromMeeting` | `POST /api/recordings/:id/unlink-meeting` |
| `recordings:selectMeeting` | `POST /api/recordings/:id/select-meeting` `{meetingId\|null}` |
| `recordings:getCandidates` | `GET /api/recordings/:id/candidates` |
| `recordings:getMeetingsNearDate` | `GET /api/recordings/meetings-near-date?date=` |
| `recordings:transcribe`, `recordings:addToQueue` | `POST /api/recordings/:id/transcribe` |
| `transcription:resummarize` | `POST /api/recordings/:id/resummarize` `{templateId?}` |
| `transcription:isSummaryStale` | `GET /api/recordings/:id/summary-stale` |
| `transcription:cancel` | `POST /api/recordings/:id/transcription/cancel` |
| `transcription:retry` | `POST /api/recordings/:id/transcription/retry` |
| `recordings:getTranscript`, `db:get-transcript`, `transcripts:getByRecordingId` | `GET /api/recordings/:id/transcript` |
| `transcripts:getByRecordingIds`, `db:get-transcripts-by-recording-ids` | `POST /api/transcripts/by-recording-ids` `{ids}` |
| `transcripts:search`, `db:search-transcripts` | `GET /api/transcripts/search?q=` |
| `transcripts:updateTurns` | `PATCH /api/recordings/:id/transcript/turns` `{turns}` |
| `transcription:getQueue`, `queue:getItems`, `db:get-queue` | `GET /api/queue?status=` |
| `transcription:updateQueueItem` | `PATCH /api/queue/:id` `{status,errorMessage?}` |
| `recordings:processQueue` | `POST /api/queue/process` |
| `transcription:cancelAll` | `POST /api/queue/cancel-all` |
| `transcription:retryAll` | `POST /api/queue/retry-failed` |
| `recordings:getTranscriptionStatus` | `GET /api/queue/status` |
| `recordings:start/stopTranscriptionProcessor` | `POST /api/queue/processor/{start,stop}` |
| `transcription:validateConfig` | `GET /api/transcription/config/validate` |

### 0c-3 — Knowledge / Synced files / Chat / Meetings / Calendar / Contacts / Projects

| IPC channel(s) | REST |
|---|---|
| `knowledge:getAll` | `GET /api/knowledge?limit&offset&status&quality&category` |
| `knowledge:getById` | `GET /api/knowledge/:id` |
| `knowledge:getByIds` | `POST /api/knowledge/by-ids` `{ids}` |
| `knowledge:update` | `PATCH /api/knowledge/:id` `{updates}` |
| `syncedFiles:getAll`, `db:get-all-synced-files` | `GET /api/synced-files` |
| `syncedFiles:getFilenames`, `db:get-synced-filenames` | `GET /api/synced-files/filenames` |
| `syncedFiles:isFileSynced`/`getSyncedFile`, `db:is-file-synced`/`get-synced-file` | `GET /api/synced-files/lookup?filename=` |
| `syncedFiles:add`, `db:add-synced-file` | `POST /api/synced-files` |
| `syncedFiles:remove`, `db:remove-synced-file` | `DELETE /api/synced-files?filename=` |
| `chat:getHistory`, `db:get-chat-history` | `GET /api/chat/history?limit=` |
| `chat:addMessage`, `db:add-chat-message` | `POST /api/chat/messages` |
| `chat:clearHistory`, `db:clear-chat-history` | `DELETE /api/chat/history` |
| `db:get-meetings`, `meetings:getAll` | `GET /api/meetings?startDate&endDate` |
| `db:get-meeting`, `meetings:getById` | `GET /api/meetings/:id` |
| `db:get-meetings-by-ids`, `meetings:getByIds` | `POST /api/meetings/by-ids` `{ids}` |
| `db:get-meeting-details`, `meetings:getDetails` | `GET /api/meetings/:id/details` |
| `meetings:update` | `PATCH /api/meetings/:id` |
| `calendar:get-settings` | `GET /api/calendar/settings` |
| `calendar:set-url`/`toggle-auto-sync`/`set-interval` | `PATCH /api/calendar/settings` |
| `calendar:get-last-sync` | `GET /api/calendar/last-sync` |
| `calendar:sync` | `POST /api/calendar/sync` |
| `calendar:clear-and-sync` | `POST /api/calendar/sync?clear=1` |
| `contacts:getAll` | `GET /api/contacts?search&type&limit&offset` |
| `contacts:getById` | `GET /api/contacts/:id` |
| `contacts:create` | `POST /api/contacts` |
| `contacts:update` | `PATCH /api/contacts/:id` |
| `contacts:delete` | `DELETE /api/contacts/:id` |
| `contacts:getForMeeting` | `GET /api/meetings/:id/contacts` |
| `contacts:getSelf` | `GET /api/contacts/self` |
| `contacts:setSelf` | `PUT /api/contacts/self` `{contactId\|null}` |
| `projects:getAll` | `GET /api/projects?search&status&limit&offset` |
| `projects:getById` | `GET /api/projects/:id` |
| `projects:create`/`update`/`delete` | `POST` / `PATCH /api/projects/:id` / `DELETE /api/projects/:id` |
| `projects:tagMeeting`/`untagMeeting` | `POST` / `DELETE /api/meetings/:id/projects/:projectId` |
| `projects:getForMeeting` | `GET /api/meetings/:id/projects` |

### 0c-4 — RAG / Assistant / Actionables / Outputs / Summarization / Templates / Quality

| IPC channel(s) | REST |
|---|---|
| `rag:status` | `GET /api/rag/status` |
| `rag:stats` | `GET /api/rag/stats` |
| `rag:chat`, `rag:chat-legacy` | `POST /api/rag/chat` (progress + tokens over `/ws`) |
| `rag:cancel` | `POST /api/rag/cancel` `{sessionId}` |
| `rag:clear-session`, `rag:removeLastMessages` | `POST /api/rag/session/{clear,trim}` |
| `rag:summarize-meeting`, `rag:find-action-items` | `POST /api/rag/{summarize-meeting,find-action-items}` |
| `rag:search`, `rag:globalSearch` | `GET /api/rag/search?q&limit&scope=` |
| `rag:get-chunks` | `GET /api/rag/chunks` |
| `rag:index-transcript` | `POST /api/rag/index` |
| `assistant:getConversations` | `GET /api/assistant/conversations` |
| `assistant:createConversation` | `POST /api/assistant/conversations` |
| `assistant:deleteConversation` | `DELETE /api/assistant/conversations/:id` |
| `assistant:updateConversationTitle` | `PATCH /api/assistant/conversations/:id` |
| `assistant:getMessages`/`addMessage` | `GET`/`POST /api/assistant/conversations/:id/messages` |
| `assistant:getContext`/`addContext`/`removeContext` | `GET`/`POST`/`DELETE /api/assistant/conversations/:id/context` |
| `actionables:getAll` | `GET /api/actionables?status=` |
| `actionables:getByMeeting` | `GET /api/meetings/:id/actionables` |
| `actionables:updateStatus` | `PATCH /api/actionables/:id` `{status}` |
| `actionables:generateOutput` | `POST /api/actionables/:id/generate-output` |
| `outputs:getTemplates` | `GET /api/outputs/templates` |
| `outputs:generate` | `POST /api/outputs/generate` |
| `outputs:getByActionableId` | `GET /api/actionables/:id/output` |
| `summarization:listModels` | `GET /api/summarization/models` |
| `summarization:testConnection` | `POST /api/summarization/test-connection` |
| `summarizationTemplates:list` | `GET /api/summarization-templates` |
| `summarizationTemplates:create`/`update`/`delete` | `POST` / `PATCH /api/summarization-templates/:id` / `DELETE /api/summarization-templates/:id` |
| `summarizationTemplates:setEnabled` | `PATCH /api/summarization-templates/:id` `{enabled}` |
| `summarizationTemplates:latestRun`/`previewSelection` | `GET /api/recordings/:id/template-{run,selection}` |
| `summarizationTemplates:acceptSuggestedTemplate` | `POST /api/recordings/:id/accept-suggested-template` |
| `quality:get`/`set` | `GET`/`PUT /api/recordings/:id/quality` |
| `quality:auto-assess` | `POST /api/recordings/:id/quality/auto-assess` |
| `quality:get-by-quality` | `GET /api/recordings?quality=` |
| `quality:batch-auto-assess`, `quality:assess-unassessed` | `POST /api/quality/{batch-assess,assess-unassessed}` |

### 0c-5 — Storage(meta) / Config / Voiceprints / Speakers / Diarization / Integrity / App / DeviceCache / Migration / StoragePolicy

| IPC channel(s) | REST |
|---|---|
| `storage:get-info` | `GET /api/storage/info` |
| `config:get`, `config:get-value` | `GET /api/config` (+ `?key=`) |
| `config:set`, `config:update-section` | `PATCH /api/config` *(admin)* |
| `voiceprints:listForContact` | `GET /api/contacts/:id/voiceprints` |
| `voiceprints:findBySource` | `GET /api/voiceprints?recordingId&fileLabel&contactId` |
| `voiceprints:enable`/`disable` | `PATCH /api/voiceprints/:id` `{enabled}` |
| `voiceprints:delete` | `DELETE /api/voiceprints/:id` |
| `voiceprints:clearAllForContact`/`clearAll` | `DELETE /api/voiceprints?contactId=` / `DELETE /api/voiceprints` |
| `speakers:getForRecording` | `GET /api/recordings/:id/speakers` |
| `speakers:getSuggestions` | `GET /api/recordings/:id/speaker-suggestions` |
| `speakers:assign`/`unassign` | `PUT`/`DELETE /api/recordings/:id/speakers/:fileLabel` |
| `speakers:merge`/`reassignTurns` | `POST /api/recordings/:id/speakers/{merge,reassign}` |
| `speakers:setSelf` | `POST /api/recordings/:id/speakers/:fileLabel/set-self` |
| `speakers:dismissSuggestion`/`acceptSuggestion` | `POST /api/speaker-suggestions/:id/{dismiss,accept}` |
| `diarization:getLatestRun`/`getRunsForRecording` | `GET /api/recordings/:id/diarization` (+ `?all=1`) |
| `integrity:get-report` | `GET /api/integrity/report` *(admin)* |
| `integrity:run-scan`/`repair-issue`/`repair-all`/`run-startup-checks`/`cleanup-wrongly-named`/`purge-missing-files` | `POST /api/integrity/<action>` *(admin; progress over `/ws`)* |
| `app:info` | `GET /api/app/info` |
| `app:restart` | `POST /api/app/restart` *(admin; semantics change — see §4)* |
| `deviceCache:getAll`/`saveAll`/`clear` | `GET`/`PUT`/`DELETE /api/device-cache` |
| `migration:getStatus`/`previewCleanup` | `GET /api/migration/{status,preview}` *(admin)* |
| `migration:runCleanup`/`runV11`/`rollbackV11` | `POST /api/migration/<action>` *(admin; progress over `/ws`)* |
| `storagePolicy:getByTier`/`getStats`/`getCleanupSuggestions[ForTier]` | `GET /api/storage-policy/...` |
| `storagePolicy:executeCleanup`/`initializeUntiered`/`assignTier` | `POST /api/storage-policy/<action>` |

---

## 4. Deferred / redesigned — handlers that do NOT port 1:1 (the real design decisions)

These are Electron-desktop affordances with no clean REST/browser equivalent. **Recommendation per item; flag any you disagree with:**

- **Binary/base64 media** — `storage:read-recording` (base64) / `storage:save-recording`: **drop from REST**; superseded by the **0d media range endpoint** (`GET /api/recordings/:id/media`) for playback and the Phase-1 upload pipeline for ingest. Do not port base64-over-JSON.
- **Native file-save dialogs** — `transcripts:export`, `outputs:saveToFile`: in Electron these open a save dialog and write to disk. In the browser → the endpoint **returns the content** (`200` + body + `Content-Disposition`) and the SDK triggers a browser download. (`outputs:copyToClipboard` → drop; clipboard is a renderer concern in 0e.)
- **Native open/reveal** — `storage:open-folder`/`open-file`/`reveal-in-folder`: **drop** (no server desktop). The SDK no-ops or offers a download link.
- **Device ingest via dialog** — `recordings:addExternal` (open-file dialog), `recordings:addExternalByPath` (server filesystem path): **defer to Phase 1** (becomes the WebUSB upload pipeline); a server-path import is meaningless for a hosted client.
- **Device domain — OUT of 0c entirely** — `jensen:*` (all device I/O) and `downloadService:*` (device sync reconciliation) are **Phase 1** (browser WebUSB). Not REST.
- **Recording watcher** — `recordings:get/start/stopWatcher`, `recordings:scanFolder`: the watcher monitors a local recordings dir. In hosted, recordings arrive via upload (Phase 1), so the watcher's role changes. **Defer watcher control to Phase 1**; `scanFolder` becomes a server-side scan of `/data/recordings` if useful, else defer.
- **`app:restart`** — no "relaunch the desktop app" in hosted. Map to **`POST /api/app/restart` = graceful server process exit** (a process manager / container restart policy brings it back), or **drop**. Recommend drop for now.
- **`migration:onProgress` / `integrity:onProgress` / `jensen:on*` / `onTranscription*` / `onDomainEvent` / `onActivityLogEntry` / `onVoiceprintCaptured`** — these are renderer **event subscriptions**, not request channels. They become **WS message handlers in 0e** keyed off the `{channel}` field (the broadcaster already emits the same channel strings). No REST endpoints.

---

## 5. Risks / open questions for your review

1. **Volume.** ~200 channels → ~150 REST endpoints after dedup, across 4 batches of ~45. Each batch is a sizable subagent-driven run (comparable to 0b). This is the bulk of the migration.
2. **`db:*` vs domain duplicates.** ~20 `db:*` channels duplicate domain channels (recordings/meetings/transcripts/synced/chat). The design folds them into one endpoint each. **Decision to confirm:** the SDK points both facade methods at the shared endpoint (no behavior change), and we don't keep the `db:` names as separate routes. ✔ recommended.
3. **Result-envelope normalization.** Handlers are inconsistent (`Result<T>`, `{success,data,error}`, raw values, legacy `throw`). The `send()` helper + a per-route error mapping standardizes this. **Decision:** one helper, applied uniformly; the SDK re-wraps for the renderer. ✔ recommended.
4. **Admin-gated domains.** `config` writes, `integrity`, `migration`, `app:restart` are destructive/global → add `requireAdmin`. **Confirm** that's the right gate (vs. any member).
5. **The deferred list (§4) is where real product decisions live** — especially: drop `app:restart`? export/output as browser download? watcher/scanFolder deferral? Please confirm or redirect each.
6. **Batching is a guideline.** If recordings (0c-2, ~30 endpoints) proves too large for one execution run, it splits further. The scaffolding lands in 0c-2 regardless.

---

## 6. On approval

Each batch (0c-2 → 0c-5) becomes its own bite-sized TDD execution plan via writing-plans, executed subagent-driven with the established review loop. 0c-2 carries the shared scaffolding (`routes/_result.ts`, the Zod error handler, the router registration + a route-test harness using `app.inject`). Domains are tested against a real better-sqlite3 DB (services are already wired); the WS-emitting actions assert via the 0c-1 broadcaster.
